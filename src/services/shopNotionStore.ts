/**
 * In-memory store for shop-specific Notion configurations
 * Maps shop domains to their Notion tokens and database IDs
 */

export interface ShopNotionConfig {
  shopDomain: string;
  notionToken: string;
  notionDbId: string;
  createdAt: Date;
  updatedAt: Date;
}

class ShopNotionStore {
  private store: Map<string, ShopNotionConfig> = new Map();

  /**
   * Store Notion configuration for a shop
   */
  setConfig(shopDomain: string, notionToken: string, notionDbId: string): void {
    const normalizedDomain = this.normalizeDomain(shopDomain);
    const now = new Date();
    
    const config: ShopNotionConfig = {
      shopDomain: normalizedDomain,
      notionToken,
      notionDbId,
      createdAt: this.store.has(normalizedDomain) ? this.store.get(normalizedDomain)!.createdAt : now,
      updatedAt: now
    };

    this.store.set(normalizedDomain, config);
    console.log(`📝 Stored Notion config for shop: ${normalizedDomain}`);
  }

  /**
   * Get Notion configuration for a shop
   */
  getConfig(shopDomain: string): ShopNotionConfig | null {
    const normalizedDomain = this.normalizeDomain(shopDomain);
    return this.store.get(normalizedDomain) || null;
  }

  /**
   * Remove configuration for a shop
   */
  removeConfig(shopDomain: string): boolean {
    const normalizedDomain = this.normalizeDomain(shopDomain);
    const deleted = this.store.delete(normalizedDomain);
    if (deleted) {
      console.log(`🗑️ Removed Notion config for shop: ${normalizedDomain}`);
    }
    return deleted;
  }

  /**
   * Get all stored configurations
   */
  getAllConfigs(): ShopNotionConfig[] {
    return Array.from(this.store.values());
  }

  /**
   * Check if a shop has configuration stored
   */
  hasConfig(shopDomain: string): boolean {
    const normalizedDomain = this.normalizeDomain(shopDomain);
    return this.store.has(normalizedDomain);
  }

  /**
   * Get store statistics
   */
  getStats() {
    return {
      totalShops: this.store.size,
      shops: Array.from(this.store.keys())
    };
  }

  /**
   * Normalize shop domain (remove .myshopify.com if present, convert to lowercase)
   */
  private normalizeDomain(domain: string): string {
    return domain
      .toLowerCase()
      .replace(/^https?:\/\//, '') // Remove protocol
      .replace(/\/$/, '') // Remove trailing slash
      .replace('.myshopify.com', ''); // Remove .myshopify.com suffix
  }

  /**
   * Clear all configurations (useful for testing)
   */
  clear(): void {
    this.store.clear();
    console.log('🧹 Cleared all shop Notion configurations');
  }
}

// Export singleton instance
export const shopNotionStore = new ShopNotionStore();
export default shopNotionStore; 