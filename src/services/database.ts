import * as sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';

export interface User {
  id: string;
  email?: string;
  notionToken: string;
  notionDbId: string;
  createdAt: Date;
}

export interface ConnectedStore {
  id: string;
  userId: string;
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

class DatabaseService {
  private db: Database | null = null;
  private dbPath: string;

  constructor() {
    // Use different database for different environments
    const environment = process.env.NODE_ENV || 'development';
    this.dbPath = path.join(__dirname, '../../data', `notionsync_${environment}.db`);
  }

  async initialize(): Promise<void> {
    try {
      // Ensure data directory exists
      const fs = require('fs');
      const dataDir = path.dirname(this.dbPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Open database connection
      this.db = await open({
        filename: this.dbPath,
        driver: sqlite3.Database
      });

      // Create tables
      await this.createTables();
      console.log(`✅ Database initialized: ${this.dbPath}`);
    } catch (error) {
      console.error('❌ Failed to initialize database:', error);
      throw error;
    }
  }

  private async createTables(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    // Users table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        notion_token TEXT NOT NULL,
        notion_db_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        migration_status TEXT DEFAULT 'pending',
        migrated_at DATETIME NULL,
        old_shared_db_id TEXT NULL,
        personal_db_id TEXT NULL
      )
    `);

    // Create unique index on email
    await this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email 
      ON users(email) WHERE email IS NOT NULL
    `);

    // Connected stores table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS connected_stores (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        shop_name TEXT NOT NULL,
        shop_domain TEXT NOT NULL,
        access_token TEXT NOT NULL,
        connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users (id),
        UNIQUE(user_id, shop_name)
      )
    `);

    // User sessions table
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    // Create indexes for performance
    await this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_stores_shop_name ON connected_stores(shop_name);
      CREATE INDEX IF NOT EXISTS idx_stores_user_id ON connected_stores(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);
    `);
  }

  async createOrGetUser(email: string, notionToken: string, notionDbId: string): Promise<User> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      // Check if user exists by email
      if (email) {
        const existingUser = await this.db.get<User>(
          'SELECT * FROM users WHERE email = ?',
          [email]
        );

        if (existingUser) {
          // Update Notion credentials if changed
          await this.db.run(
            'UPDATE users SET notion_token = ?, notion_db_id = ? WHERE id = ?',
            [notionToken, notionDbId, existingUser.id]
          );
          
          return {
            ...existingUser,
            notionToken,
            notionDbId,
            createdAt: new Date(existingUser.createdAt)
          };
        }
      }

      // Create new user
      const userId = this.generateId();
      const user: User = {
        id: userId,
        email,
        notionToken,
        notionDbId,
        createdAt: new Date()
      };

      await this.db.run(
        'INSERT INTO users (id, email, notion_token, notion_db_id) VALUES (?, ?, ?, ?)',
        [userId, email, notionToken, notionDbId]
      );

      console.log(`👤 Created new user: ${email} (${userId})`);
      return user;
    } catch (error) {
      console.error('❌ Error creating/getting user:', error);
      throw error;
    }
  }

  async addStoreToUser(userId: string, shopName: string, shopDomain: string, accessToken: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const storeId = this.generateId();
      
      await this.db.run(`
        INSERT OR REPLACE INTO connected_stores 
        (id, user_id, shop_name, shop_domain, access_token, is_active)
        VALUES (?, ?, ?, ?, ?, 1)
      `, [storeId, userId, shopName, shopDomain, accessToken]);

      console.log(`➕ Added/updated store ${shopName} for user ${userId}`);
      return true;
    } catch (error) {
      console.error('❌ Error adding store to user:', error);
      return false;
    }
  }

  async getUser(userId: string): Promise<User | undefined> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const user = await this.db.get<User>(
        'SELECT * FROM users WHERE id = ?',
        [userId]
      );

      if (user) {
        return {
          ...user,
          createdAt: new Date(user.createdAt)
        };
      }
      return undefined;
    } catch (error) {
      console.error('❌ Error getting user:', error);
      return undefined;
    }
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const user = await this.db.get<User>(
        'SELECT * FROM users WHERE email = ?',
        [email]
      );

      if (user) {
        return {
          ...user,
          createdAt: new Date(user.createdAt)
        };
      }
      return undefined;
    } catch (error) {
      console.error('❌ Error getting user by email:', error);
      return undefined;
    }
  }

  async createSession(userId: string): Promise<string> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const sessionId = this.generateId();
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await this.db.run(
        'INSERT INTO user_sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)',
        [sessionId, userId, expiresAt.toISOString()]
      );

      return sessionId;
    } catch (error) {
      console.error('❌ Error creating session:', error);
      throw error;
    }
  }

  async getUserBySession(sessionId: string): Promise<User | undefined> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.get(`
        SELECT u.*, s.expires_at
        FROM users u
        JOIN user_sessions s ON u.id = s.user_id
        WHERE s.session_id = ? AND s.expires_at > datetime('now')
      `, [sessionId]);

      if (result) {
        return {
          id: result.id,
          email: result.email,
          notionToken: result.notion_token,
          notionDbId: result.notion_db_id,
          createdAt: new Date(result.created_at)
        };
      }
      return undefined;
    } catch (error) {
      console.error('❌ Error getting user by session:', error);
      return undefined;
    }
  }

  async getAllUsersWithStore(shopName: string): Promise<Array<{ user: User; store: ConnectedStore }>> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const results = await this.db.all(`
        SELECT 
          u.id as user_id, u.email, u.notion_token, u.notion_db_id, u.created_at,
          s.id as store_id, s.shop_name, s.shop_domain, s.access_token, s.connected_at, s.is_active
        FROM users u
        JOIN connected_stores s ON u.id = s.user_id
        WHERE s.shop_name = ? AND s.is_active = 1
      `, [shopName]);

      return results.map((row: any) => ({
        user: {
          id: row.user_id,
          email: row.email,
          notionToken: row.notion_token,
          notionDbId: row.notion_db_id,
          createdAt: new Date(row.created_at)
        },
        store: {
          id: row.store_id,
          userId: row.user_id,
          shopName: row.shop_name,
          shopDomain: row.shop_domain,
          accessToken: row.access_token,
          connectedAt: new Date(row.connected_at),
          isActive: row.is_active === 1
        }
      }));
    } catch (error) {
      console.error('❌ Error getting users with store:', error);
      return [];
    }
  }

  async updateUserNotionDb(userId: string, notionDbId: string): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const result = await this.db.run(
        'UPDATE users SET notion_db_id = ?, personal_db_id = ?, migration_status = ? WHERE id = ?',
        [notionDbId, notionDbId, 'completed', userId]
      );

      if (result.changes && result.changes > 0) {
        console.log(`📊 Updated Notion DB ID for user ${userId}: ${notionDbId}`);
        return true;
      }
      return false;
    } catch (error) {
      console.error('❌ Error updating user Notion DB:', error);
      return false;
    }
  }

  async getStats(): Promise<{ totalUsers: number; totalStores: number; migrations: { pending: number; completed: number } }> {
    if (!this.db) throw new Error('Database not initialized');

    try {
      const userCount = await this.db.get('SELECT COUNT(*) as count FROM users');
      const storeCount = await this.db.get('SELECT COUNT(*) as count FROM connected_stores WHERE is_active = 1');
      const pendingMigrations = await this.db.get('SELECT COUNT(*) as count FROM users WHERE migration_status = "pending"');
      const completedMigrations = await this.db.get('SELECT COUNT(*) as count FROM users WHERE migration_status = "completed"');

      return {
        totalUsers: userCount?.count || 0,
        totalStores: storeCount?.count || 0,
        migrations: {
          pending: pendingMigrations?.count || 0,
          completed: completedMigrations?.count || 0
        }
      };
    } catch (error) {
      console.error('❌ Error getting stats:', error);
      return { totalUsers: 0, totalStores: 0, migrations: { pending: 0, completed: 0 } };
    }
  }

  async cleanup(): Promise<void> {
    try {
      // Clean up expired sessions
      if (this.db) {
        await this.db.run('DELETE FROM user_sessions WHERE expires_at < datetime("now")');
      }
    } catch (error) {
      console.error('❌ Error cleaning up database:', error);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      console.log('📊 Database connection closed');
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }
}

// Export singleton instance
export const databaseService = new DatabaseService(); 