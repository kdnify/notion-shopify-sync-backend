export interface User {
  id: string;
  email?: string;
  notionToken: string;
  notionDbId: string;
  createdAt: Date;
  stores: ConnectedStore[];
}

export interface ConnectedStore {
  shopName: string;
  shopDomain: string;
  accessToken: string;
  connectedAt: Date;
  isActive: boolean;
}

export interface UserSession {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

// In-memory storage (in production, use a proper database)
class UserStoreService {
  private users: Map<string, User> = new Map();
  private sessions: Map<string, UserSession> = new Map();
  private usersByEmail: Map<string, string> = new Map();

  /**
   * Create or get user by email and Notion credentials
   */
  createOrGetUser(email: string, notionToken: string, notionDbId: string): User {
    // Check if user exists by email
    const existingUserId = this.usersByEmail.get(email);
    if (existingUserId) {
      const user = this.users.get(existingUserId);
      if (user) {
        // Update Notion credentials if changed
        user.notionToken = notionToken;
        user.notionDbId = notionDbId;
        return user;
      }
    }

    // Create new user
    const userId = this.generateId();
    const user: User = {
      id: userId,
      email,
      notionToken,
      notionDbId,
      createdAt: new Date(),
      stores: []
    };

    this.users.set(userId, user);
    this.usersByEmail.set(email, userId);
    
    console.log(`👤 Created new user: ${email} (${userId})`);
    return user;
  }

  /**
   * Add or update a store for a user
   */
  addStoreToUser(userId: string, shopName: string, shopDomain: string, accessToken: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    // Check if store already exists
    const existingStoreIndex = user.stores.findIndex(store => store.shopName === shopName);
    
    if (existingStoreIndex >= 0) {
      // Update existing store
      user.stores[existingStoreIndex] = {
        shopName,
        shopDomain,
        accessToken,
        connectedAt: user.stores[existingStoreIndex].connectedAt,
        isActive: true
      };
      console.log(`🔄 Updated store ${shopName} for user ${userId}`);
    } else {
      // Add new store
      user.stores.push({
        shopName,
        shopDomain,
        accessToken,
        connectedAt: new Date(),
        isActive: true
      });
      console.log(`➕ Added store ${shopName} for user ${userId}`);
    }

    return true;
  }

  /**
   * Get user by ID
   */
  getUser(userId: string): User | undefined {
    return this.users.get(userId);
  }

  /**
   * Get user by email
   */
  getUserByEmail(email: string): User | undefined {
    const userId = this.usersByEmail.get(email);
    return userId ? this.users.get(userId) : undefined;
  }

  /**
   * Create a session for a user
   */
  createSession(userId: string): string {
    const sessionId = this.generateId();
    const session: UserSession = {
      userId,
      sessionId,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
    };

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  /**
   * Get user by session ID
   */
  getUserBySession(sessionId: string): User | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAt < new Date()) {
      if (session) this.sessions.delete(sessionId);
      return undefined;
    }

    return this.users.get(session.userId);
  }

  /**
   * Get all users with their stores (for webhook processing)
   */
  getAllUsersWithStore(shopName: string): Array<{ user: User; store: ConnectedStore }> {
    const results: Array<{ user: User; store: ConnectedStore }> = [];
    
    for (const user of this.users.values()) {
      const store = user.stores.find(s => s.shopName === shopName && s.isActive);
      if (store) {
        results.push({ user, store });
      }
    }

    return results;
  }

  /**
   * Remove a store from a user
   */
  removeStoreFromUser(userId: string, shopName: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    const storeIndex = user.stores.findIndex(store => store.shopName === shopName);
    if (storeIndex >= 0) {
      user.stores[storeIndex].isActive = false;
      console.log(`❌ Deactivated store ${shopName} for user ${userId}`);
      return true;
    }

    return false;
  }

  /**
   * Update Notion Database ID for a user
   */
  updateUserNotionDb(userId: string, notionDbId: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    user.notionDbId = notionDbId;
    console.log(`📊 Updated Notion DB ID for user ${userId}: ${notionDbId}`);
    return true;
  }

  /**
   * Get stats
   */
  getStats() {
    const totalUsers = this.users.size;
    const totalStores = Array.from(this.users.values())
      .reduce((sum, user) => sum + user.stores.filter(s => s.isActive).length, 0);
    
    return { totalUsers, totalStores };
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
}

export const userStoreService = new UserStoreService(); 