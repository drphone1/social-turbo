/**
 * CSV Import/Export Service
 * Handles importing and exporting contacts and campaigns
 */

import { logger } from './logger';

export interface ContactCSVRow {
  name: string;
  phone: string;
  email?: string;
  company?: string;
  tags?: string;
  [key: string]: any;
}

export interface CampaignCSVRow {
  id?: string;
  name: string;
  message: string;
  accountId: string;
  contactCount?: number;
  status?: string;
  createdAt?: string;
}

export interface CSVParseResult {
  success: boolean;
  dataCount: number;
  data: any[];
  errors: string[];
  warnings: string[];
}

/**
 * Parse CSV string to array of objects
 * Handles different delimiters and quotes
 */
export function parseCSVString(csvContent: string): CSVParseResult {
  try {
    const result: CSVParseResult = {
      success: false,
      dataCount: 0,
      data: [],
      errors: [],
      warnings: [],
    };

    if (!csvContent || csvContent.trim().length === 0) {
      result.errors.push('CSV content is empty');
      return result;
    }

    // Remove BOM if present
    let cleanContent = csvContent;
    if (cleanContent.charCodeAt(0) === 0xFEFF) {
      cleanContent = cleanContent.slice(1);
    }

    // Split by lines
    const lines = cleanContent.split('\n').filter(line => line.trim().length > 0);
    
    if (lines.length < 2) {
      result.errors.push('CSV must have header row and at least one data row');
      return result;
    }

    // Parse header
    const headerLine = lines[0];
    const headers = parseCSVLine(headerLine);

    if (headers.length === 0) {
      result.errors.push('CSV header is empty');
      return result;
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      try {
        const rowLine = lines[i];
        if (rowLine.trim().length === 0) continue;

        const values = parseCSVLine(rowLine);
        
        // Warn if column count mismatch
        if (values.length !== headers.length) {
          result.warnings.push(`Row ${i + 1}: column count mismatch (expected ${headers.length}, got ${values.length})`);
        }

        // Create object with header keys
        const rowObject: Record<string, any> = {};
        for (let j = 0; j < headers.length; j++) {
          rowObject[headers[j]] = values[j] || '';
        }

        result.data.push(rowObject);
      } catch (error: any) {
        result.errors.push(`Row ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    result.success = result.errors.length === 0;
    result.dataCount = result.data.length;

    return result;
  } catch (error) {
    logger.error(`Error parsing CSV: ${error}`);
    return {
      success: false,
      dataCount: 0,
      data: [],
      errors: [`Failed to parse CSV: ${error instanceof Error ? error.message : String(error)}`],
      warnings: [],
    };
  }
}

/**
 * Parse a single CSV line, handling quotes and escapes
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i += 2;
      } else {
        // Toggle quote state
        inQuotes = !inQuotes;
        i++;
      }
    } else if (char === ',' && !inQuotes) {
      // Field separator
      result.push(current.trim());
      current = '';
      i++;
    } else {
      current += char;
      i++;
    }
  }

  // Add last field
  result.push(current.trim());

  return result;
}

/**
 * Convert array of objects to CSV string
 */
export function convertToCSV(data: Record<string, any>[]): string {
  try {
    if (!Array.isArray(data) || data.length === 0) {
      return '';
    }

    // Get headers from first object
    const headers = Object.keys(data[0]);

    // Create CSV lines
    const csvLines: string[] = [];

    // Add header
    csvLines.push(headers.map(h => escapeCSVValue(String(h))).join(','));

    // Add data rows
    for (const row of data) {
      const values = headers.map(header => {
        const value = row[header];
        return escapeCSVValue(String(value || ''));
      });
      csvLines.push(values.join(','));
    }

    return csvLines.join('\n');
  } catch (error) {
    logger.error(`Error converting to CSV: ${error}`);
    return '';
  }
}

/**
 * Escape CSV value for safe output
 */
function escapeCSVValue(value: string): string {
  // If contains comma, quote, or newline, wrap in quotes
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    // Escape quotes by doubling them
    const escaped = value.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return value;
}

/**
 * Validate contact data from CSV
 */
export function validateContactData(data: any[]): { valid: any[]; invalid: Array<{row: any; errors: string[]}> } {
  const valid: any[] = [];
  const invalid: Array<{row: any; errors: string[]}> = [];

  for (const row of data) {
    const errors: string[] = [];

    // Validate required fields
    if (!row.name || row.name.trim().length === 0) {
      errors.push('Name is required');
    }

    if (!row.phone || row.phone.trim().length === 0) {
      errors.push('Phone is required');
    } else {
      // Basic phone validation
      if (!/^\d{7,15}$|^\+\d{1,3}\d{7,14}$/.test(row.phone.replace(/[\s\-\(\)\.]/g, ''))) {
        errors.push('Invalid phone format');
      }
    }

    // Validate email if present
    if (row.email && row.email.trim().length > 0) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
        errors.push('Invalid email format');
      }
    }

    if (errors.length > 0) {
      invalid.push({ row, errors });
    } else {
      valid.push(row);
    }
  }

  return { valid, invalid };
}

/**
 * Validate campaign data from CSV
 */
export function validateCampaignData(data: any[]): { valid: any[]; invalid: Array<{row: any; errors: string[]}> } {
  const valid: any[] = [];
  const invalid: Array<{row: any; errors: string[]}> = [];

  for (const row of data) {
    const errors: string[] = [];

    // Validate required fields
    if (!row.name || row.name.trim().length === 0) {
      errors.push('Campaign name is required');
    }

    if (!row.message || row.message.trim().length === 0) {
      errors.push('Campaign message is required');
    }

    if (!row.accountId || row.accountId.trim().length === 0) {
      errors.push('Account ID is required');
    }

    if (errors.length > 0) {
      invalid.push({ row, errors });
    } else {
      valid.push(row);
    }
  }

  return { valid, invalid };
}

/**
 * Generate sample CSV template for contacts
 */
export function getContactCSVTemplate(): string {
  const template: ContactCSVRow[] = [
    {
      name: 'John Doe',
      phone: '1234567890',
      email: 'john@example.com',
      company: 'Example Inc',
      tags: 'vip,customer',
    },
    {
      name: 'Jane Smith',
      phone: '9876543210',
      email: 'jane@example.com',
      company: 'Tech Corp',
      tags: 'buyer',
    },
  ];

  return convertToCSV(template);
}

/**
 * Generate sample CSV template for campaigns
 */
export function getCampaignCSVTemplate(): string {
  const template: CampaignCSVRow[] = [
    {
      name: 'Welcome Campaign',
      message: 'Hello {{name}}, welcome to our service!',
      accountId: 'account-1',
      status: 'draft',
    },
    {
      name: 'Product Launch',
      message: 'Hi {{name}}, check out our new product!',
      accountId: 'account-1',
      status: 'draft',
    },
  ];

  return convertToCSV(template);
}

/**
 * Batch import contacts
 */
export function parseContactsFromCSV(csvContent: string): CSVParseResult {
  const parseResult = parseCSVString(csvContent);

  if (!parseResult.success) {
    return parseResult;
  }

  // Validate contact data
  const validation = validateContactData(parseResult.data);

  return {
    success: validation.invalid.length === 0,
    dataCount: validation.valid.length,
    data: validation.valid,
    errors: parseResult.errors.concat(
      validation.invalid.map(inv => `Row validation failed: ${inv.errors.join(', ')}`)
    ),
    warnings: parseResult.warnings,
  };
}

/**
 * Batch import campaigns
 */
export function parseCampaignsFromCSV(csvContent: string): CSVParseResult {
  const parseResult = parseCSVString(csvContent);

  if (!parseResult.success) {
    return parseResult;
  }

  // Validate campaign data
  const validation = validateCampaignData(parseResult.data);

  return {
    success: validation.invalid.length === 0,
    dataCount: validation.valid.length,
    data: validation.valid,
    errors: parseResult.errors.concat(
      validation.invalid.map(inv => `Row validation failed: ${inv.errors.join(', ')}`)
    ),
    warnings: parseResult.warnings,
  };
}
