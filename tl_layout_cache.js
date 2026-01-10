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
     * Store layout positions from Cytoscape instance
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
};

/**
 * Get optimized layout settings based on graph size
 * @param {number} nodeCount - Number of nodes in graph
 * @param {number} edgeCount - Number of edges in graph
 * @returns {Object} Optimized settings
 */
export function getOptimizedSettings(nodeCount, edgeCount) {
    // Base settings - optimized for performance
    const settings = {
        ranker: 'network-simplex',  // Fastest ranker
        acyclicer: 'greedy',        // Faster than default (dfs)
        align: undefined,            // Undefined is faster than specific alignment
    };

    // For medium graphs (50+ nodes), start optimizing spacing
    if (nodeCount >= 50) {
        console.log(`[Timeline Layout] Medium graph (${nodeCount} nodes), optimizing spacing`);
        settings.spacingFactor = 0.95;  // Slight reduction
        settings.nodeSep = 40;          // Reduce from default 50
    }

    // For large graphs (100+ nodes), use more aggressive optimizations
    if (nodeCount >= 100) {
        console.log(`[Timeline Layout] Large graph (${nodeCount} nodes), using aggressive optimizations`);
        settings.spacingFactor = 0.85;
        settings.nodeSep = 30;
        settings.edgeSep = 5;          // Reduce from default 10
        settings.rankSep = 40;         // Reduce from default 50
    }

    // For very large graphs (200+ nodes), maximize performance
    if (nodeCount >= 200) {
        console.log(`[Timeline Layout] Very large graph (${nodeCount} nodes), maximizing performance`);
        settings.spacingFactor = 0.75;
        settings.nodeSep = 25;
        settings.edgeSep = 3;
        settings.rankSep = 35;
    }

    // For extremely large graphs (500+ nodes), use minimal spacing
    if (nodeCount >= 500) {
        console.log(`[Timeline Layout] Extremely large graph (${nodeCount} nodes), using minimal spacing`);
        settings.spacingFactor = 0.65;
        settings.nodeSep = 20;
        settings.edgeSep = 2;
        settings.rankSep = 30;
    }

    return settings;
}

/**
 * Helper to run layout with caching
 * @param {Object} cy - Cytoscape instance
 * @param {Object} layoutOptions - Layout configuration
 * @param {boolean} forceRecompute - Force layout recalculation even if cached
 * @returns {Promise} Resolves when layout is complete
 */
export async function runLayoutWithCache(cy, layoutOptions, forceRecompute = false) {
    const elements = cy.elements().jsons();
    const cacheKey = layoutCache.generateKey(elements);

    // Try to use cached layout
    if (!forceRecompute) {
        const cachedPositions = layoutCache.get(cacheKey);
        if (cachedPositions) {
            console.log('[Timeline Layout Cache] Using cached layout');
            layoutCache.applyPositions(cy, cachedPositions);
            return { fromCache: true };
        }
    }

    // Count nodes and edges
    const nodes = elements.filter(e => e.group === 'nodes');
    const edges = elements.filter(e => e.group === 'edges');
    const nodeCount = nodes.length;
    const edgeCount = edges.length;

    console.log(`[Timeline Layout] Computing layout for ${nodeCount} nodes, ${edgeCount} edges`);

    // Apply size-based optimizations
    const sizeOptimizations = getOptimizedSettings(nodeCount, edgeCount);
    const optimizedOptions = { ...layoutOptions, ...sizeOptimizations };

    // Run layout on main thread
    return new Promise((resolve) => {
        const startTime = performance.now();

        const layout = cy.elements().makeLayout(optimizedOptions);

        layout.on('layoutstop', () => {
            const duration = performance.now() - startTime;
            console.log(`[Timeline Layout] Layout computed in ${duration.toFixed(2)}ms`);

            // Cache the result
            layoutCache.set(cacheKey, cy);

            resolve({ fromCache: false, duration });
        });

        layout.run();
    });
}
