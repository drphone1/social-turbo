/**
 * Contact Deduplication Service
 * Detects and handles duplicate contacts
 */

import { logger } from './logger';

export interface ContactData {
  id?: string;
  name?: string;
  fullName?: string;
  phone: string;
  email?: string;
  [key: string]: any;
}

export interface DuplicateGroup {
  primary: ContactData;
  duplicates: ContactData[];
  matchType: 'phone' | 'email' | 'name' | 'multiple';
  confidence: number;
}

export interface DeduplicationResult {
  totalContacts: number;
  duplicateGroups: DuplicateGroup[];
  duplicateCount: number;
  confidence: number;
}

/**
 * Find duplicate contacts by phone number
 */
export function findDuplicatesByPhone(contacts: ContactData[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < contacts.length; i++) {
    const phone1 = normalizePhone(contacts[i].phone);
    if (processed.has(phone1)) continue;

    const duplicates: ContactData[] = [];
    for (let j = i + 1; j < contacts.length; j++) {
      const phone2 = normalizePhone(contacts[j].phone);
      if (phone1 === phone2 && phone1.length > 0) {
        duplicates.push(contacts[j]);
        processed.add(phone2);
      }
    }

    if (duplicates.length > 0) {
      processed.add(phone1);
      groups.push({
        primary: contacts[i],
        duplicates,
        matchType: 'phone',
        confidence: 1.0,
      });
    }
  }

  return groups;
}

/**
 * Find duplicate contacts by email
 */
export function findDuplicatesByEmail(contacts: ContactData[]): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < contacts.length; i++) {
    if (!contacts[i].email) continue;
    const email1 = contacts[i].email!.toLowerCase();
    if (processed.has(email1)) continue;

    const duplicates: ContactData[] = [];
    for (let j = i + 1; j < contacts.length; j++) {
      if (!contacts[j].email) continue;
      const email2 = contacts[j].email!.toLowerCase();
      if (email1 === email2) {
        duplicates.push(contacts[j]);
        processed.add(email2);
      }
    }

    if (duplicates.length > 0) {
      processed.add(email1);
      groups.push({
        primary: contacts[i],
        duplicates,
        matchType: 'email',
        confidence: 0.9,
      });
    }
  }

  return groups;
}

/**
 * Find duplicate-like contacts by name similarity
 */
export function findDuplicatesByName(contacts: ContactData[], threshold = 0.85): DuplicateGroup[] {
  const groups: DuplicateGroup[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < contacts.length; i++) {
    const contactName = (contacts[i].name || contacts[i].fullName || '').toLowerCase().trim();
    if (!contactName || processed.has(contactName)) continue;

    const duplicates: ContactData[] = [];
    for (let j = i + 1; j < contacts.length; j++) {
      const name2 = (contacts[j].name || contacts[j].fullName || '').toLowerCase().trim();
      if (!name2) continue;
      const similarity = calculateStringSimilarity(contactName, name2);
      if (similarity >= threshold) {
        duplicates.push(contacts[j]);
        processed.add(name2);
      }
    }

    if (duplicates.length > 0) {
      processed.add(contactName);
      const dup0Name = (duplicates[0].name || duplicates[0].fullName || '').toLowerCase().trim();
      const similarity = duplicates.length > 0 
        ? calculateStringSimilarity(contactName, dup0Name) 
        : 0;
      
      groups.push({
        primary: contacts[i],
        duplicates,
        matchType: 'name',
        confidence: similarity,
      });
    }
  }

  return groups;
}

/**
 * Find all duplicates using multiple criteria
 */
export function findAllDuplicates(contacts: ContactData[]): DeduplicationResult {
  const groups: DuplicateGroup[] = [];
  const phoneGroups = findDuplicatesByPhone(contacts);
  const emailGroups = findDuplicatesByEmail(contacts);
  const nameGroups = findDuplicatesByName(contacts);

  // Merge groups (avoid duplicates in results)
  const merged = new Map<string, DuplicateGroup>();

  // Add phone duplicates
  for (const group of phoneGroups) {
    const key = group.primary.id || group.primary.phone;
    merged.set(key, group);
  }

  // Add email duplicates
  for (const group of emailGroups) {
    const key = group.primary.id || group.primary.email;
    if (key && !merged.has(key)) {
      merged.set(key, group);
    }
  }

  // Add name duplicates
  for (const group of nameGroups) {
    const key = group.primary.id || group.primary.name || group.primary.fullName;
    if (key && !merged.has(key)) {
      merged.set(key, group);
    }
  }

  const duplicateCount = Array.from(merged.values()).reduce(
    (sum, group) => sum + group.duplicates.length,
    0
  );

  const avgConfidence = merged.size > 0
    ? Array.from(merged.values()).reduce((sum, g) => sum + g.confidence, 0) / merged.size
    : 0;

  return {
    totalContacts: contacts.length,
    duplicateGroups: Array.from(merged.values()),
    duplicateCount,
    confidence: avgConfidence,
  };
}

/**
 * Merge duplicate contacts
 */
export function mergeDuplicates(primary: ContactData, duplicates: ContactData[]): ContactData {
  const merged = { ...primary };

  for (const dup of duplicates) {
    // Take non-empty fields from duplicates
    for (const key of Object.keys(dup)) {
      if (!merged[key] && dup[key]) {
        merged[key] = dup[key];
      }
    }
  }

  return merged;
}

/**
 * Normalize phone number for comparison
 */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * Calculate string similarity (Levenshtein distance based)
 */
function calculateStringSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;

  if (longer.length === 0) return 1.0;

  const editDistance = getEditDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Calculate Levenshtein distance
 */
function getEditDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[str2.length][str1.length];
}
