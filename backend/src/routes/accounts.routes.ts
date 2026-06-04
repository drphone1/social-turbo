import { Express } from 'express';
import { db } from '../database';
import { whatsappAccounts, accountContacts, contacts } from '../database/schema';
import { eq, desc } from 'drizzle-orm';
import { connectAccount, disconnectAccount, latestPairingCodes, latestQrs, deleteSession, getGroups, extractGroupMembers, requestPairingCode } from '../modules/whatsapp/baileys.service';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { getOperationalHealthOverview } from '../services/operational-health.service';

export function setupAccountRoutes(app: Express) {
  // Health
  app.get('/api/health', (req, res) => {
    const overview = getOperationalHealthOverview('7days');
    res.json({
      status: overview.overallStatus === 'healthy' ? 'ok' : overview.overallStatus,
      db: 'ready',
      runtime: overview,
    });
  });

  // Accounts - Get all
  app.get('/api/accounts', (req, res) => {
    try {
      const accounts = db.select().from(whatsappAccounts).all();
      res.json(accounts);
    } catch (error: any) {
      logger.error('Error fetching accounts:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Get QR code
  app.get('/api/accounts/:id/qr', (req, res) => {
    try {
      const { id } = req.params;
      res.json({ qr: latestQrs[id] || null });
    } catch (error: any) {
      logger.error('Error fetching QR:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Get latest pairing code
  app.get('/api/accounts/:id/pairing-code', (req, res) => {
    try {
      const { id } = req.params;
      res.json(latestPairingCodes[id] || null);
    } catch (error: any) {
      logger.error('Error fetching pairing code:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Request pairing code
  app.post('/api/accounts/:id/pairing-code', async (req, res) => {
    try {
      const { id } = req.params;
      const { phoneNumber } = req.body || {};

      if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber is required' });
      }

      const pairing = await requestPairingCode(id, phoneNumber);
      res.json(pairing);
    } catch (error: any) {
      logger.error('Error generating pairing code:', error);
      res.status(400).json({ error: error.message });
    }
  });

  // Accounts - Create new
  app.post('/api/accounts', (req, res) => {
    try {
      const { phone, displayName, proxyProfileId } = req.body;
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required' });
      }

      const id = uuidv4();
      db.insert(whatsappAccounts).values({
        id,
        phoneNumber: phone,
        displayName: displayName || phone,
        status: 'connecting',
        proxyProfileId: proxyProfileId || null,
        createdAt: new Date().toISOString()
      }).run();
      
      connectAccount(id);
      res.json({ id, status: 'connecting' });
    } catch (error: any) {
      logger.error('Error creating account:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Connect
  app.post('/api/accounts/:id/connect', (req, res) => {
    try {
      const { id } = req.params;
      connectAccount(id);
      res.json({ status: 'connecting' });
    } catch (error: any) {
      logger.error('Error connecting account:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Disconnect
  app.post('/api/accounts/:id/disconnect', (req, res) => {
    try {
      const { id } = req.params;
      disconnectAccount(id);
      res.json({ status: 'disconnected' });
    } catch (error: any) {
      logger.error('Error disconnecting account:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Delete
  app.delete('/api/accounts/:id', async (req, res) => {
    try {
      const { id } = req.params;
      await deleteSession(id);
      db.delete(whatsappAccounts).where(eq(whatsappAccounts.id, id)).run();
      res.json({ status: 'deleted' });
    } catch (error: any) {
      logger.error('Error deleting account:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Update
  app.put('/api/accounts/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { displayName, phone, proxyProfileId } = req.body;
      
      db.update(whatsappAccounts)
        .set({
          displayName,
          phoneNumber: phone,
          ...(proxyProfileId !== undefined ? { proxyProfileId: proxyProfileId || null } : {})
        })
        .where(eq(whatsappAccounts.id, id))
        .run();
      
      res.json({ status: 'updated' });
    } catch (error: any) {
      logger.error('Error updating account:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Accounts - Get groups
  app.get('/api/accounts/:id/groups', async (req, res) => {
    try {
      const { id } = req.params;
      const groups = await getGroups(id);
      res.json(groups);
    } catch (error: any) {
      logger.error('Error fetching groups:', error);
      res.status(400).json({ error: error.message });
    }
  });

  // Accounts - Get account contacts
  app.get('/api/accounts/:id/contacts', async (req, res) => {
    try {
      const { id } = req.params;
      const { sort = 'recent' } = req.query;
      
      let accountContactsQuery = db.select().from(accountContacts).where(eq(accountContacts.accountId, id));
      
      let result;
      if (sort === 'recent') {
        result = accountContactsQuery.orderBy(desc(accountContacts.lastInteraction)).all();
      } else if (sort === 'name') {
        result = accountContactsQuery.orderBy(accountContacts.name).all();
      } else {
        result = accountContactsQuery.all();
      }
      
      res.json(result);
    } catch (error: any) {
      logger.error('Error fetching account contacts:', error);
      res.status(400).json({ error: error.message });
    }
  });

  // Accounts - Extract contacts
  app.post('/api/accounts/:id/contacts/extract', async (req, res) => {
    try {
      const { id } = req.params;
      const { phones } = req.body;
      
      const accountContactsList = db.select().from(accountContacts)
        .where(eq(accountContacts.accountId, id))
        .all();
      
      const contactsToExtract = phones && phones.length > 0 
        ? accountContactsList.filter((c: any) => phones.includes(c.phone))
        : accountContactsList;

      let addedCount = 0;
      for (const c of contactsToExtract) {
        if (!c.phone) continue;
        
        const existingContact = db.select().from(contacts)
          .where(eq(contacts.phone, c.phone))
          .all();
          
        if (existingContact.length === 0) {
          db.insert(contacts).values({
            id: uuidv4(),
            fullName: c.name || `Contact (${c.phone})`,
            phone: c.phone,
            source: 'contacts_tab',
            tags: JSON.stringify(['Source: Contacts Tab']),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }).run();
          addedCount++;
        }
      }
      
      res.json({ total: contactsToExtract.length, added: addedCount });
    } catch (error: any) {
      logger.error('Error extracting contacts:', error);
      res.status(400).json({ error: error.message });
    }
  });

  // Accounts - Extract group members
  app.post('/api/accounts/:id/groups/:groupId/extract', async (req, res) => {
    try {
      const { id, groupId } = req.params;
      const result = await extractGroupMembers(id, groupId);
      res.json({ extracted: result.total || 0, ...result });
    } catch (error: any) {
      logger.error('Error extracting group members:', error);
      res.status(400).json({ error: error.message });
    }
  });
}
