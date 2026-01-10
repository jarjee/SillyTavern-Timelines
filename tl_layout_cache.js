/**
 * Layout Cache Module
 * Caches computed graph layouts to avoid expensive dagre recalculations
 */

/**
 * Simple LRU cache for layout positions
 */
class LayoutCache {
    constructor(maxSize = 10) {
        this.cache = new Map();
        this.maxSize = maxSize;
    }

    /**
     * Generate a cache key from graph structure
     * @param {Array} elements - Cytoscape elements
     * @returns {string} Cache key
     */
    generateKey(elements) {
        const nodes = elements.filter(e => e.group === 'nodes');
        const edges = elements.filter(e => e.group === 'edges');

        // Create a structural hash based on node IDs and edge connections
        const nodeIds = nodes.map(n => n.data.id).sort().join(',');
        const edgeIds = edges.map(e => `${e.data.source}->${e.data.target}`).sort().join(',');

        return `${nodeIds}|${edgeIds}`;
    }

    /**
     * Get cached layout positions
     * @param {string} key - Cache key
     * @returns {Map|null} Map of node ID to position {x, y}, or null if not cached
     */
    get(key) {
        if (this.cache.has(key)) {
            // Move to end (most recently used)
            const value = this.cache.get(key);
            this.cache.delete(key);
            this.cache.set(key, value);
            return value;
        }
        return null;
    }

    /**
     * Store layout positions
     * @param {string} key - Cache key
     * @param {Object} cy - Cytoscape instance
     */
    set(key, cy) {
        // Store positions of all nodes
        const positions = new Map();
        cy.nodes().forEach(node => {
            const pos = node.position();
            positions.set(node.id(), { x: pos.x, y: pos.y });
        });

        // Implement LRU eviction
        if (this.cache.size >= this.maxSize) {
            // Delete the oldest entry (first in Map)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, positions);
    }

    /**
     * Apply cached positions to Cytoscape instance
     * @param {Object} cy - Cytoscape instance
     * @param {Map} positions - Map of node ID to position
     * @returns {boolean} True if all positions were applied successfully
     */
    applyPositions(cy, positions) {
        try {
            cy.nodes().forEach(node => {
                const pos = positions.get(node.id());
                if (pos) {
                    node.position(pos);
                }
            });
            return true;
        } catch (e) {
            console.error('[Timeline Layout Cache] Error applying positions:', e);
            return false;
        }
    }

    /**
     * Clear the cache
     */
    clear() {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache stats
     */
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            keys: Array.from(this.cache.keys())
        };
    }
}

// Export singleton instance
export const layoutCache = new LayoutCache(10);

/**
 * Optimized dagre layout configuration
 * These settings balance performance with layout quality
 */
export const optimizedDagreSettings = {
    // Use fastest ranker algorithm
    ranker: 'network-simplex',  // Fastest: network-simplex > tight-tree > longest-path

    // Use greedy acyclicer (faster than undefined)
    acyclicer: 'greedy',

    // Reduce edge weight iterations for faster computation
    // Note: This is an internal dagre setting, may not be exposed by cytoscape-dagre
    // edgeWeight: (e) => 1,  // Uniform weights are faster to compute
};

/**
 * Helper to run layout with caching
 * @param {Object} cy - Cytoscape instance
 * @param {Object} layoutOptions - Layout configuration
 * @param {boolean} forceRecompute - Force layout recalculation even if cached
 * @returns {Promise} Resolves when layout is complete
 */
export function runLayoutWithCache(cy, layoutOptions, forceRecompute = false) {
    return new Promise((resolve) => {
        const elements = cy.elements().jsons();
        const cacheKey = layoutCache.generateKey(elements);

        // Try to use cached layout
        if (!forceRecompute) {
            const cachedPositions = layoutCache.get(cacheKey);
            if (cachedPositions) {
                console.log('[Timeline Layout Cache] Using cached layout');
                layoutCache.applyPositions(cy, cachedPositions);
                resolve({ fromCache: true });
                return;
            }
        }

        // Compute new layout
        console.log('[Timeline Layout Cache] Computing new layout');
        const startTime = performance.now();

        const layout = cy.elements().makeLayout(layoutOptions);

        layout.on('layoutstop', () => {
            const duration = performance.now() - startTime;
            console.log(`[Timeline Layout Cache] Layout computed in ${duration.toFixed(2)}ms`);

            // Cache the result
            layoutCache.set(cacheKey, cy);

            resolve({ fromCache: false, duration });
        });

        layout.run();
    });
}
