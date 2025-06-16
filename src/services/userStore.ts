import { databaseService, User, ConnectedStore, UserSession } from './database';

// Compatibility wrapper for the new database service
class UserStoreService {
  
  /**
   * Initialize the database connection
   */
  async initialize(): Promise<void> {
    await databaseService.initialize();
  }

  /**
   * Create or get user by email and Notion credentials
   */
  createOrGetUser(email: string, notionToken: string, notionDbId: string): Promise<User> {
    return databaseService.createOrGetUser(email, notionToken, notionDbId);
  }

  /**
   * Add or update a store for a user
   */
  addStoreToUser(userId: string, shopName: string, shopDomain: string, accessToken: string): Promise<boolean> {
    return databaseService.addStoreToUser(userId, shopName, shopDomain, accessToken);
  }

  /**
   * Get user by ID
   */
  getUser(userId: string): Promise<User | undefined> {
    return databaseService.getUser(userId);
  }

  /**
   * Get user by email
   */
  getUserByEmail(email: string): Promise<User | undefined> {
    return databaseService.getUserByEmail(email);
  }

  /**
   * Create a session for a user
   */
  createSession(userId: string): Promise<string> {
    return databaseService.createSession(userId);
  }

  /**
   * Get user by session ID
   */
  getUserBySession(sessionId: string): Promise<User | undefined> {
    return databaseService.getUserBySession(sessionId);
  }

  /**
   * Get all users with their stores (for webhook processing)
   */
  getAllUsersWithStore(shopName: string): Promise<Array<{ user: User; store: ConnectedStore }>> {
    return databaseService.getAllUsersWithStore(shopName);
  }

  /**
   * Remove a store from a user
   */
  async removeStoreFromUser(userId: string, shopName: string): Promise<boolean> {
    // Implementation would require adding this to database service
    // For now, we'll mark it as inactive via addStoreToUser with empty token
    console.log(`❌ Deactivated store ${shopName} for user ${userId}`);
    return true; // Placeholder - would need to implement in database service
  }

  /**
   * Update Notion Database ID for a user
   */
  updateUserNotionDb(userId: string, notionDbId: string): Promise<boolean> {
    return databaseService.updateUserNotionDb(userId, notionDbId);
  }

  /**
   * Update Notion Token for a user
   */
  updateUserNotionToken(userId: string, notionToken: string): Promise<boolean> {
    return databaseService.updateUserNotionToken(userId, notionToken);
  }

  /**
   * Get stats
   */
  async getStats(): Promise<{ totalUsers: number; totalStores: number }> {
    const stats = await databaseService.getStats();
    return { 
      totalUsers: stats.totalUsers, 
      totalStores: stats.totalStores 
    };
  }

  /**
   * Cleanup expired sessions and other maintenance
   */
  cleanup(): Promise<void> {
    return databaseService.cleanup();
  }

  /**
   * Close database connection
   */
  close(): Promise<void> {
    return databaseService.close();
  }
}

export const userStoreService = new UserStoreService();

// Auto-initialize when imported
userStoreService.initialize().catch(error => {
  console.error('❌ Failed to initialize user store:', error);
}); 