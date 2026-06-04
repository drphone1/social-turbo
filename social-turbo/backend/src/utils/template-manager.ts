/**
 * Message Template Management
 * Save and manage reusable message templates
 */

import { logger } from './logger';

export interface MessageTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string[];
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
  usageCount?: number;
}

export interface TemplateData {
  name: string;
  description: string;
  content: string;
  category: string;
  tags: string[];
}

// In-memory storage (in production, use database)
const templates = new Map<string, MessageTemplate>();

/**
 * Create a new template
 */
export function createTemplate(data: TemplateData): MessageTemplate {
  const id = generateTemplateId();
  const template: MessageTemplate = {
    id,
    ...data,
    variables: extractVariables(data.content),
    createdAt: new Date(),
    updatedAt: new Date(),
    usageCount: 0,
  };

  templates.set(id, template);
  logger.info(`Template created: ${id} - ${data.name}`);
  return template;
}

/**
 * Get template by ID
 */
export function getTemplate(id: string): MessageTemplate | null {
  return templates.get(id) || null;
}

/**
 * Get all templates
 */
export function getAllTemplates(): MessageTemplate[] {
  return Array.from(templates.values()).sort((a, b) =>
    b.updatedAt.getTime() - a.updatedAt.getTime()
  );
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: string): MessageTemplate[] {
  return Array.from(templates.values()).filter(
    t => t.category.toLowerCase() === category.toLowerCase()
  );
}

/**
 * Search templates
 */
export function searchTemplates(query: string): MessageTemplate[] {
  const q = query.toLowerCase();
  return Array.from(templates.values()).filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    t.category.toLowerCase().includes(q) ||
    t.tags.some(tag => tag.toLowerCase().includes(q))
  );
}

/**
 * Update template
 */
export function updateTemplate(id: string, data: Partial<TemplateData>): MessageTemplate | null {
  const template = templates.get(id);
  if (!template) return null;

  const updated: MessageTemplate = {
    ...template,
    ...data,
    id: template.id,
    createdAt: template.createdAt,
    updatedAt: new Date(),
    usageCount: template.usageCount,
    variables: data.content ? extractVariables(data.content) : template.variables,
  };

  templates.set(id, updated);
  logger.info(`Template updated: ${id}`);
  return updated;
}

/**
 * Delete template
 */
export function deleteTemplate(id: string): boolean {
  const deleted = templates.delete(id);
  if (deleted) {
    logger.info(`Template deleted: ${id}`);
  }
  return deleted;
}

/**
 * Increment usage count
 */
export function incrementUsage(id: string): void {
  const template = templates.get(id);
  if (template) {
    template.usageCount = (template.usageCount || 0) + 1;
    template.updatedAt = new Date();
  }
}

/**
 * Get popular templates
 */
export function getPopularTemplates(limit = 10): MessageTemplate[] {
  return getAllTemplates()
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0))
    .slice(0, limit);
}

/**
 * Get template statistics
 */
export function getTemplateStats(): Record<string, any> {
  const all = getAllTemplates();
  const categories = new Set(all.map(t => t.category));
  const allTags = new Set<string>();
  all.forEach(t => t.tags.forEach(tag => allTags.add(tag)));

  return {
    totalTemplates: all.length,
    categories: Array.from(categories),
    categoryCount: categories.size,
    uniqueTags: Array.from(allTags),
    totalVariables: all.reduce((sum, t) => sum + t.variables.length, 0),
    totalUsage: all.reduce((sum, t) => sum + (t.usageCount || 0), 0),
    mostUsed: getPopularTemplates(5),
  };
}

/**
 * Get default templates
 */
export function getDefaultTemplates(): MessageTemplate[] {
  const defaults = [
    {
      name: 'Welcome Message',
      description: 'Welcome new customers',
      content: 'Hi {{name}}, welcome to our service! 👋',
      category: 'greeting',
      tags: ['welcome', 'greeting'],
    },
    {
      name: 'Promotional',
      description: 'Send promotional messages',
      content: 'Special offer for you {{name}}! Check out our latest products.',
      category: 'marketing',
      tags: ['promo', 'offer'],
    },
    {
      name: 'Support Response',
      description: 'Support team response',
      content: 'Hi {{name}}, thanks for contacting us. How can we help?',
      category: 'support',
      tags: ['support', 'help'],
    },
    {
      name: 'Follow-up',
      description: 'Follow-up message',
      content: 'Hi {{name}}, just checking in! Is there anything we can help with?',
      category: 'engagement',
      tags: ['follow-up', 'engagement'],
    },
  ];

  return defaults
    .filter(d => !Array.from(templates.values()).some(t => t.name === d.name))
    .map(d => createTemplate(d as TemplateData));
}

/**
 * Load default templates once
 */
export function initializeDefaultTemplates(): void {
  if (templates.size === 0) {
    getDefaultTemplates();
    logger.info(`Loaded ${templates.size} default templates`);
  }
}

/**
 * Generate template ID
 */
function generateTemplateId(): string {
  return `tpl_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Extract variables from template
 */
function extractVariables(content: string): string[] {
  const regex = /\{\{(\w+)\}\}/g;
  const vars: string[] = [];
  let match;

  while ((match = regex.exec(content)) !== null) {
    if (!vars.includes(match[1])) {
      vars.push(match[1]);
    }
  }

  return vars;
}
