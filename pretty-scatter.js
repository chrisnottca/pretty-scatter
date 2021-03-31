(function (root, factory) {
	if ( typeof define === 'function' && define.amd ) {
		define([], factory(root));
	} else if ( typeof exports === 'object' ) {
		module.exports = factory(root);
	} else {
		root.PrettyScatter = factory(root);
	}
})(typeof global !== "undefined" ? global : this.window || this.global, function (root) {

  // constants
  const countPoissonDistributionIterationsLimit = 50;
  const minAllowedDistanceBetweenPointsMultiple = 1.3; // as a multiple of element radius
  const initialPoissonRadiusMultiple = 1.8; // as a multiple of the element radius
  const poissonRadiusAdjustmentMultiple = 0.05; // as a multiple of current radius
  const eventResponseDelay = 200;
  
  let containerElement,
      minViewportWidth,
      parentElement,
      scatterElements,
      countScatterElements,
      exclusionZones,
      particleElementDimensions,
      scatterElementRadius,
      containerElementDimensions,
      resizeTimeout = null;

  const init = (element, viewportWidth) => {
    if (element) {
      containerElement = element;
      minViewportWidth = viewportWidth | 0;
      
      parentElement = containerElement.parentElement;
      scatterElements = Array.from(containerElement.childNodes).filter(node => node.nodeType === Node.ELEMENT_NODE);
      countScatterElements = scatterElements.length;
      exclusionZones = Array.from(parentElement.childNodes).filter(node => (node.nodeType === Node.ELEMENT_NODE && node !== containerElement));
      
      // store original display css value (reapply later to revert back)
      containerElement.style.initialDisplay = getComputedStyle(containerElement).display;
      
      // get particle dimensions (assume all particles are the same size) (do
      // before everything is hidden)
      particleElementDimensions = scatterElements[0].getBoundingClientRect();
      scatterElementRadius = Math.sqrt(2 * Math.pow(
        (particleElementDimensions.width > particleElementDimensions.height ? 
        particleElementDimensions.width / 2 :
        particleElementDimensions.height / 2),
        2));

      // do any resolution-specific initialization
      initResponsive();

      // handle window resizes - redo resolution-specific initialization
      window.addEventListener(
        'resize', 
        handleResize.bind(this),
        true
      );
    }
  };

  const initResponsive = () => {
    if (utils.getViewportWidth() > minViewportWidth) {
      // get dimensions of area (do before everything is hidden)
      containerElementDimensions = parentElement.getBoundingClientRect();

      // apply classes for static styles
      containerElement.classList.add('pretty-scatter__field');
      parentElement.classList.add('pretty-scatter__container');
      parentElement.style.height = containerElementDimensions.height + 'px';

      // also get the boundaries of the exclusion zones here as they may vary
      // based on viewport dimensions
      determineExclusionZoneBoundaries();

      // hide everything
      containerElement.style.display = 'none';

      // find a good poisson distribution of points
      findBestPoissonDistribution();
    
    // if viewport is below min width, revert classes and apply original display
    // css property
    } else {
      restoreOriginalAppearance();
    }
  };

  const handleResize = () => {
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(initResponsive.bind(this), eventResponseDelay);
  };

  const determineExclusionZoneBoundaries = () => {
    const boundaries = [
      { name: 'top',    parentCompare: null },
      { name: 'bottom', parentCompare: 'height' },
      { name: 'left',   parentCompare: null  },
      { name: 'right',  parentCompare: 'width' }
      ];
    const countExclusionZones = exclusionZones.length;
    for (let zoneIndex = 0; zoneIndex < countExclusionZones; zoneIndex++) {
      let zone = exclusionZones[zoneIndex];
      zone.boundaries = utils.getBoundingAncestorRect(zone, zone.parentElement);
      
      // any valid regions that are too small to fit a particle element, extend
      // the exclusion zone to fill that region currently only evaluate regions
      // between main field and each exclusion zone
      for (let boundaryIndex = 0; boundaryIndex < 4; boundaryIndex++) {
        const boundary = boundaries[boundaryIndex];
        let parentBoundary = boundary.parentCompare ? containerElementDimensions[boundary.parentCompare] : 0;
        if (Math.abs(zone.boundaries[boundary.name] - parentBoundary) <= scatterElementRadius) {
          zone.boundaries[boundary.name] = parentBoundary;
        }
      }
    }
  };

  const restoreOriginalAppearance = () => {
    containerElement.classList.remove('pretty-scatter__field');
    parentElement.classList.remove('pretty-scatter__container');
    containerElement.style.display = containerElement.style.initialDisplay;
    parentElement.style.height = 'auto';
  };

  const findBestPoissonDistribution = () => {
    let countIterations = 0;
    let poissonPoints = []
    
    // initial poisson radius
    let poissonRadius = scatterElementRadius * initialPoissonRadiusMultiple;
    
    // run poisson disc sampler until the returned number of particles is the
    // same as the number of items we want to scatter or we exceed the number of
    // iterations allowed
    while (
      countIterations < countPoissonDistributionIterationsLimit && 
      poissonPoints.length !== countScatterElements
      ) {
      poissonPoints = poissonDiscSampler(
        containerElementDimensions.width,
        containerElementDimensions.height,
        poissonRadius,
        scatterElementRadius,
        exclusionZones
      );

      // if the returned number of particles doesn't match the number of scatter
      // items, adjust the poisson radius to encourage a closer result next
      // iteration
      if (poissonPoints.length !== countScatterElements) {
        let radiusAdjustment = poissonRadiusAdjustmentMultiple * (poissonPoints.length - countScatterElements) / countScatterElements;
        poissonRadius *= 1 + radiusAdjustment;
      }
      
      countIterations++;
    }
    
    // if we didn't exceed the number of iterations without a solution and the
    // successful poisson radius larger than the minimum limit, rmove scatter
    // items to final particle positions
    if (
      poissonPoints.length === countScatterElements &&
      poissonRadius >= minAllowedDistanceBetweenPointsMultiple * scatterElementRadius
      ) {
      for (let i = 0; i < poissonPoints.length; i++) {
        let point = poissonPoints[i];
        let scatterElement = scatterElements[i];
        let offset = Math.sqrt(Math.pow(scatterElementRadius, 2) / 2);
        scatterElement.style.top = point[1] - offset + 'px';
        scatterElement.style.left = point[0] - offset + 'px';
      }

      // show everything again
      containerElement.style.display = 'block';
    
    // otherwise, evert back to original display
    } else {
      restoreOriginalAppearance();
    }
  };

  // from https://observablehq.com/@techsparx/an-improvement-on-bridsons-algorithm-for-poisson-disc-samp/2
  // with modifications to allow exclusion zones
  const poissonDiscSampler = (width, height, radius, pointSize, exclusionZones) => {
    const k = 8; // maximum number of samples before rejection
    const radius2 = radius * radius;
    const cellSize = radius * Math.SQRT1_2;
    const gridWidth = Math.ceil(width / cellSize);
    const gridHeight = Math.ceil(height / cellSize);
    const grid = new Array(gridWidth * gridHeight);
    const queue = [];
    const accepted = [];

    // Pick the first sample.
    // make 20 tries before giving up and returning no points
    let x, y;
    let firstSampleTries = 0;
    while (firstSampleTries < 20 && isNaN(x) || isNaN(y) || countExclusionZoneCollisions(x, y, exclusionZones) !== 0) {
      x = pointSize + Math.random() * (width - 2 * pointSize);
      y = pointSize + Math.random() * (height - 2 * pointSize);
      firstSampleTries++;
    }
    if (countExclusionZoneCollisions(x, y, exclusionZones) === 0) {
      sample(x, y, null);
    } else {
      return [];
    }

    // Pick a random existing sample from the queue.
    pick: while (queue.length) {
      const i = Math.random() * queue.length | 0;
      const parent = queue[i];
      const seed = Math.random();
      const epsilon = 0.0000001;
      
      // Make a new candidate.
      for (let j = 0; j < k; ++j) {
        const a = 2 * Math.PI * (seed + 1.0*j/k);
        const r = radius + epsilon;
        const x = parent[0] + r * Math.cos(a);
        const y = parent[1] + r * Math.sin(a);

        // Accept candidates that are inside the allowed extent and farther than
        // 2 * radius to all existing samples. and doesn't collide with any
        // exclusion zones
        const countCollisions = countExclusionZoneCollisions(x, y, exclusionZones);
        if (pointSize <= x && x < width - pointSize && pointSize <= y && y < height - pointSize && far(x, y) && countCollisions === 0) {
          sample(x, y, parent);
          continue pick;
        }
      }

      // If none of k candidates were accepted, remove it from the queue.
      const r = queue.pop();
      if (i < queue.length) queue[i] = r;
      accepted.filter(point => point === parent);
    }
    return accepted;

    function far(x, y) {
      const i = x / cellSize | 0;
      const j = y / cellSize | 0;
      const i0 = Math.max(i - 2, 0);
      const j0 = Math.max(j - 2, 0);
      const i1 = Math.min(i + 3, gridWidth);
      const j1 = Math.min(j + 3, gridHeight);
      for (let j = j0; j < j1; ++j) {
        const o = j * gridWidth;
        for (let i = i0; i < i1; ++i) {
          const s = grid[o + i];
          if (s) {
            const dx = s[0] - x;
            const dy = s[1] - y;
            if (dx * dx + dy * dy < radius2) return false;
          }
        }
      }
      return true;
    }

    function sample(x, y, parent) {
      const s = grid[gridWidth * (y / cellSize | 0) + (x / cellSize | 0)] = [x, y];
      queue.push(s);
      accepted.push(s);
      return s;
    }

    function countExclusionZoneCollisions(x, y, exclusionZones) {
      let countCollisions;
      if (!isNaN(x) && !isNaN(y)) {
        countCollisions = exclusionZones.filter(zone => isPositionInsideBox(x, y, zone.boundaries)).length;
      }
      return countCollisions;
    }

    function isPositionInsideBox(x, y, box) {
      let isInside;
      if (!isNaN(x) && !isNaN(y) && box && utils.isPropertiesDefined(box, ['left', 'right', 'top', 'bottom'])) {
        isInside = (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom);
      }
      return isInside;
    }
  }

  const utils = {
    /**
     * Similar to Element.getBoundingClientRect() and returns the same set of
     * values but with the origin being an arbitrary ancestor of the element as
     * opposed to the viewport
     *
     * @param {HTMLElement} element The element of interest
     * @param {HTMLElement} ancestor The reference ancestor element
     * @return {DOMRect} Object with properties width, height, top, bottom,
     *  left, right, x, y
     */
     getBoundingAncestorRect: (element, ancestor) => {
      if (ancestor.contains(element)) {
        const boundingClientRect = element.getBoundingClientRect();
        const ancestorBoundingClientRect = ancestor.getBoundingClientRect();
        const boundingParentRect = {
          width: boundingClientRect.width,
          height: boundingClientRect.height,
          top: boundingClientRect.top - ancestorBoundingClientRect.top,
          bottom: boundingClientRect.bottom - ancestorBoundingClientRect.top,
          left: boundingClientRect.left - ancestorBoundingClientRect.left,
          right: boundingClientRect.right - ancestorBoundingClientRect.left
          };
        boundingParentRect.x = boundingParentRect.left;
        boundingParentRect.y = boundingParentRect.top;
        return boundingParentRect;
      }
    },

    /**
     * Browser-independent way to get the viewport width.
     *
     * @return {Number}
     */
    getViewportWidth: () => {
      return Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
    },

    /**
     * Check that a list of properties are defined (regardless of value ) for
     * an object.
     *
     * @param {Object} obj The parent object of the properties
     * @param {Array of Strings} propList The list of property names
     * @return {Boolean}
     */
    isPropertiesDefined: (obj, propList) => {
      let isAllDefined = true;
      if (typeof obj === 'object' && propList.constructor === Array) {
        const countProps = propList.length;
        for (let i = 0; i < countProps; i++) {
          if (typeof obj[propList[i]] === 'undefined') {
            isAllDefined = false;
            break;
          }
        }
      }
      return isAllDefined;
    }
  };

  return {
    init: init
  };
});