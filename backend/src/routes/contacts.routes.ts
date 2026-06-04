import { Express } from 'express';
import { db } from '../database';
import { contacts, contactActivities } from '../database/schema';
import { eq, desc } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';
import { segmentByTag, segmentByCompany, segmentByCountry, segmentByActivity } from '../utils/contact-segmentation';

export function setupContactRoutes(app: Express) {
  // Get all contacts
  app.get('/api/contacts', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      res.json(allContacts);
    } catch (error: any) {
      logger.error('Error fetching contacts:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Create contact
  app.post('/api/contacts', (req, res) => {
    try {
      const { fullName, phone, email, country, city, tags, notes } = req.body;
      
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required' });
      }

      const id = uuidv4();
      db.insert(contacts).values({
        id,
        fullName,
        phone,
        email,
        country,
        city,
        tags: JSON.stringify(tags || []),
        notes,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).run();

      // Log activity
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: id,
        action: 'مخاطب اضافہ شد',
        description: `${fullName || phone} اضافہ کیا گیا`,
        details: `شماره: ${phone}${email ? ' | ای میل: ' + email : ''}`,
        type: 'contact_added',
        activityData: null,
        createdAt: new Date().toISOString()
      }).run();

      res.json({ id, status: 'created' });
    } catch (error: any) {
      logger.error('Error creating contact:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Delete contact
  app.delete('/api/contacts/:id', (req, res) => {
    try {
      const { id } = req.params;
      const contact = db.select().from(contacts).where(eq(contacts.id, id)).all()[0];
      
      if (!contact) {
        return res.status(404).json({ error: 'Contact not found' });
      }

      db.delete(contacts).where(eq(contacts.id, id)).run();

      // Log activity
      db.insert(contactActivities).values({
        id: uuidv4(),
        contactId: id,
        action: 'مخاطب حذف شد',
        description: `${contact.fullName || contact.phone} حذف کیا گیا`,
        details: `شماره: ${contact.phone}`,
        type: 'contact_deleted',
        activityData: null,
        createdAt: new Date().toISOString()
      }).run();

      res.json({ status: 'deleted' });
    } catch (error: any) {
      logger.error('Error deleting contact:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Update contact
  app.put('/api/contacts/:id', (req, res) => {
    try {
      const { id } = req.params;
      const { fullName, phone, email, country, city, tags, notes } = req.body;

      db.update(contacts)
        .set({
          fullName,
          phone,
          email,
          country,
          city,
          tags: JSON.stringify(tags || []),
          notes,
          updatedAt: new Date().toISOString()
        })
        .where(eq(contacts.id, id))
        .run();

      res.json({ status: 'updated' });
    } catch (error: any) {
      logger.error('Error updating contact:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get contact activities
  app.get('/api/contacts/activities', (req, res) => {
    try {
      const allActivities = db.select().from(contactActivities).all();
      const sorted = allActivities.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      logger.error('Error fetching activities:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Get specific contact activities
  app.get('/api/contacts/:id/activities', (req, res) => {
    try {
      const { id } = req.params;
      const activities = db.select().from(contactActivities)
        .where(eq(contactActivities.contactId, id))
        .all();
      
      const sorted = activities.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      res.json(sorted);
    } catch (error: any) {
      logger.error('Error fetching contact activities:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Add activity to contact
  app.post('/api/contacts/:id/activities', (req, res) => {
    try {
      const { id } = req.params;
      const { action, description, details, type } = req.body;

      const activity = {
        id: uuidv4(),
        contactId: id,
        action,
        description,
        details: details || null,
        type: type || 'note_added',
        activityData: null,
        createdAt: new Date().toISOString()
      };

      db.insert(contactActivities).values(activity).run();
      res.json(activity);
    } catch (error: any) {
      logger.error('Error adding activity:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Segmentation - By tag
  app.get('/api/contacts/segments/by-tag', (req, res) => {
    try {
      const allContacts = db.select().from(contacts).all();
      const segments: Record<string, any[]> = {};

      allContacts.forEach((contact: any) => {
        let tags: string[] = [];

        try {
          tags = JSON.parse(contact.tags || '[]');
        } catch (error) {
          tags = [];
        }

        if (tags.length === 0) {
          if (!segments['بدون تگ']) {
            segments['بدون تگ'] = [];
          }

          segments['بدون تگ'].push(contact);
          return;
        }

        tags.forEach((tag: string) => {
          if (!segments[tag]) {
            segments[tag] = [];
          }

          segments[tag].push(contact);
        });
      });

      const result = Object.entries(segments).map(([tag, list]) => ({
        segment: tag,
        count: list.length,
        contacts: list,
      }));

      res.json(result);
    } catch (error: any) {
      logger.error('Error segmenting by tag:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Segmentation - By company
  app.get('/api/contacts/segments/by-company', (req, res) => {
    try {
      const { company = 'Unknown' } = req.query;
      const allContacts = db.select().from(contacts).all();
      const segment = segmentByCompany(allContacts as any, company as string);
      res.json(segment);
    } catch (error: any) {
      logger.error('Error segmenting by company:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Segmentation - By country
  app.get('/api/contacts/segments/by-country', (req, res) => {
    try {
      const { country = '98' } = req.query;
      const allContacts = db.select().from(contacts).all();
      const segment = segmentByCountry(allContacts as any, country as string);
      res.json(segment);
    } catch (error: any) {
      logger.error('Error segmenting by country:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Segmentation - By activity
  app.get('/api/contacts/segments/by-activity', (req, res) => {
    try {
      const { activity = 'active' } = req.query;
      const validActivities = ['active', 'inactive', 'highValue', 'lowValue'];
      const activityType = validActivities.includes(activity as string) 
        ? (activity as any)
        : 'active';
      
      const allContacts = db.select().from(contacts).all();
      const segment = segmentByActivity(allContacts as any, activityType);
      res.json(segment);
    } catch (error: any) {
      logger.error('Error segmenting by activity:', error);
      res.status(500).json({ error: error.message });
    }
  });
}
