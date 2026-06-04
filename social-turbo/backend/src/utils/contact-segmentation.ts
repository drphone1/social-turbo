/**
 * Contact Segmentation Service
 * Groups contacts based on various criteria for targeted campaigns
 */

import { logger } from './logger';

export interface ContactData {
  id?: string;
  name?: string;
  fullName?: string;
  phone: string;
  email?: string;
  company?: string;
  tags?: string[] | string;
  lastInteraction?: string | Date;
  messageCount?: number;
  [key: string]: any;
}

export interface Segment {
  id: string;
  name: string;
  description: string;
  contacts: ContactData[];
  count: number;
  criteria: SegmentCriteria;
}

export interface SegmentCriteria {
  type: 'tag' | 'company' | 'country' | 'activity' | 'custom' | 'combination';
  value?: string | string[];
  condition?: 'equals' | 'contains' | 'startsWith' | 'gt' | 'lt' | 'between';
  dateRange?: { from: Date; to: Date };
  customFunction?: (contact: ContactData) => boolean;
}

export interface SegmentationResult {
  totalContacts: number;
  segmentCount: number;
  segments: Segment[];
}

/**
 * Segment contacts by tag
 */
export function segmentByTag(contacts: ContactData[], tag: string): Segment {
  const filtered = contacts.filter(c => {
    const tags = Array.isArray(c.tags) ? c.tags : (typeof c.tags === 'string' ? c.tags.split(';') : []);
    return tags.some(t => t.toLowerCase().includes(tag.toLowerCase()));
  });

  return {
    id: `tag-${tag}`,
    name: `Segment: ${tag}`,
    description: `Contacts tagged with "${tag}"`,
    contacts: filtered,
    count: filtered.length,
    criteria: { type: 'tag', value: tag },
  };
}

/**
 * Segment contacts by company
 */
export function segmentByCompany(contacts: ContactData[], company: string): Segment {
  const filtered = contacts.filter(c =>
    c.company && c.company.toLowerCase().includes(company.toLowerCase())
  );

  return {
    id: `company-${company.replace(/\s+/g, '_')}`,
    name: `Segment: ${company}`,
    description: `Contacts from company "${company}"`,
    contacts: filtered,
    count: filtered.length,
    criteria: { type: 'company', value: company },
  };
}

/**
 * Segment contacts by country (extracted from phone number)
 */
export function segmentByCountry(contacts: ContactData[], countryCode: string): Segment {
  const filtered = contacts.filter(c => {
    const phone = c.phone.replace(/\D/g, '');
    return phone.startsWith(countryCode.replace('+', ''));
  });

  return {
    id: `country-${countryCode}`,
    name: `Segment: Country ${countryCode}`,
    description: `Contacts from country code +${countryCode}`,
    contacts: filtered,
    count: filtered.length,
    criteria: { type: 'country', value: countryCode },
  };
}

/**
 * Segment contacts by activity level
 */
export function segmentByActivity(
  contacts: ContactData[],
  type: 'active' | 'inactive' | 'highValue' | 'lowValue'
): Segment {
  let filtered: ContactData[] = [];
  let description = '';

  switch (type) {
    case 'active':
      // Contacts with recent interaction (within 7 days)
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      
      filtered = contacts.filter(c => {
        if (!c.lastInteraction) return false;
        const interactionDate = new Date(c.lastInteraction);
        return interactionDate >= sevenDaysAgo;
      });
      description = 'Contacts with recent activity (last 7 days)';
      break;

    case 'inactive':
      // Contacts with no recent interaction
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      filtered = contacts.filter(c => {
        if (!c.lastInteraction) return true; // Never contacted
        const interactionDate = new Date(c.lastInteraction);
        return interactionDate < thirtyDaysAgo;
      });
      description = 'Contacts with no recent activity (>30 days)';
      break;

    case 'highValue':
      // Contacts with many messages
      const avgMessages = contacts.reduce((sum, c) => sum + (c.messageCount || 0), 0) / contacts.length;
      filtered = contacts.filter(c => (c.messageCount || 0) > avgMessages * 1.5);
      description = `Contacts with above-average message count (>${(avgMessages * 1.5).toFixed(0)})`;
      break;

    case 'lowValue':
      // Contacts with few or no messages
      filtered = contacts.filter(c => !c.messageCount || c.messageCount === 0);
      description = 'Contacts with no messages sent';
      break;
  }

  return {
    id: `activity-${type}`,
    name: `Segment: ${type.charAt(0).toUpperCase() + type.slice(1)}`,
    description,
    contacts: filtered,
    count: filtered.length,
    criteria: { type: 'activity', value: type },
  };
}

/**
 * Segment with custom filtering function
 */
export function segmentByCustom(
  contacts: ContactData[],
  name: string,
  filterFunction: (contact: ContactData) => boolean
): Segment {
  const filtered = contacts.filter(filterFunction);

  return {
    id: `custom-${name.replace(/\s+/g, '_')}`,
    name: `Segment: ${name}`,
    description: `Custom segment: ${name}`,
    contacts: filtered,
    count: filtered.length,
    criteria: { type: 'custom', customFunction: filterFunction },
  };
}

/**
 * Combine multiple segments (union)
 */
export function combineSegments(segments: Segment[], name: string): Segment {
  const combined = new Set<string>();
  const contacts: ContactData[] = [];

  for (const segment of segments) {
    for (const contact of segment.contacts) {
      const id = contact.id || contact.phone;
      if (!combined.has(id)) {
        combined.add(id);
        contacts.push(contact);
      }
    }
  }

  return {
    id: `combined-${name.replace(/\s+/g, '_')}`,
    name: `Segment: ${name}`,
    description: `Combined segment from ${segments.length} segments`,
    contacts,
    count: contacts.length,
    criteria: { type: 'combination' },
  };
}

/**
 * Intersect segments (contacts in all segments)
 */
export function intersectSegments(segments: Segment[], name: string): Segment {
  if (segments.length === 0) {
    return {
      id: `intersect-${name.replace(/\s+/g, '_')}`,
      name: `Segment: ${name}`,
      description: 'Empty intersection',
      contacts: [],
      count: 0,
      criteria: { type: 'combination' },
    };
  }

  const firstContactIds = new Set<string>(
    segments[0].contacts.map(c => c.id || c.phone)
  );

  const contacts = segments[0].contacts.filter(contact => {
    const contactId = contact.id || contact.phone;
    return segments.slice(1).every(segment =>
      segment.contacts.some(c => (c.id || c.phone) === contactId)
    );
  });

  return {
    id: `intersect-${name.replace(/\s+/g, '_')}`,
    name: `Segment: ${name}`,
    description: `Intersection of ${segments.length} segments`,
    contacts,
    count: contacts.length,
    criteria: { type: 'combination' },
  };
}

/**
 * Split contacts into equal segments
 */
export function splitIntoSegments(
  contacts: ContactData[],
  count: number
): Segment[] {
  const segments: Segment[] = [];
  const segmentSize = Math.ceil(contacts.length / count);

  for (let i = 0; i < count; i++) {
    const start = i * segmentSize;
    const end = start + segmentSize;
    const segmentContacts = contacts.slice(start, end);

    segments.push({
      id: `split-${i + 1}`,
      name: `Segment ${i + 1}`,
      description: `Split segment ${i + 1}/${count}`,
      contacts: segmentContacts,
      count: segmentContacts.length,
      criteria: { type: 'custom' },
    });
  }

  return segments;
}

/**
 * Get segment statistics
 */
export function getSegmentStats(segment: Segment): Record<string, any> {
  const avgMessages = segment.contacts.reduce((sum, c) => sum + (c.messageCount || 0), 0) / (segment.count || 1);
  const companiesSet = new Set(segment.contacts.map(c => c.company).filter(Boolean));
  const tagsSet = new Set<string>();
  segment.contacts.forEach(c => {
    const tags = Array.isArray(c.tags) ? c.tags : (typeof c.tags === 'string' ? c.tags.split(';') : []);
    tags.forEach(t => tagsSet.add(t.trim()));
  });

  return {
    totalContacts: segment.count,
    avgMessagesPerContact: avgMessages.toFixed(2),
    uniqueCompanies: companiesSet.size,
    companies: Array.from(companiesSet),
    uniqueTags: tagsSet.size,
    tags: Array.from(tagsSet),
    contactsWithEmail: segment.contacts.filter(c => c.email).length,
    emailPercentage: ((segment.contacts.filter(c => c.email).length / segment.count) * 100).toFixed(1),
  };
}

/**
 * Get suggested segments based on data
 */
export function getSuggestedSegments(contacts: ContactData[]): { name: string; type: string; count: number }[] {
  const suggestions: { name: string; type: string; count: number }[] = [];

  // Get unique companies
  const companies = new Set<string>();
  const tags = new Set<string>();
  const countries = new Set<string>();

  contacts.forEach(c => {
    if (c.company) companies.add(c.company);
    
    if (c.tags) {
      const tagList = Array.isArray(c.tags) ? c.tags : c.tags.split(';');
      tagList.forEach(t => tags.add(t.trim()));
    }

    if (c.phone) {
      const phoneDigits = c.phone.replace(/\D/g, '');
      if (phoneDigits.length >= 3) {
        countries.add(phoneDigits.substring(0, Math.min(3, phoneDigits.length)));
      }
    }
  });

  // Add company suggestions
  Array.from(companies).slice(0, 5).forEach(c => {
    const count = contacts.filter(cnt => cnt.company === c).length;
    if (count > 0) {
      suggestions.push({ name: c, type: 'company', count });
    }
  });

  // Add tag suggestions
  Array.from(tags).slice(0, 5).forEach(t => {
    const count = contacts.filter(c => {
      const list = Array.isArray(c.tags) ? c.tags : (typeof c.tags === 'string' ? c.tags.split(';') : []);
      return list.some(tag => tag.trim() === t);
    }).length;
    if (count > 0) {
      suggestions.push({ name: t, type: 'tag', count });
    }
  });

  return suggestions;
}
