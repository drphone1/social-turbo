/**
 * Phone Number Validator
 * Validates and formats phone numbers for WhatsApp messaging
 */

import { logger } from './logger';

export interface ValidationResult {
  isValid: boolean;
  number: string;
  countryCode: string;
  formattedNumber: string;
  error?: string;
}

// Country-specific phone number patterns
const COUNTRY_PATTERNS: Record<string, { pattern: RegExp; length: number; code: string }> = {
  US: { pattern: /^1?(\d{10})$/, length: 10, code: '1' },
  UK: { pattern: /^44(\d{10})$/, length: 10, code: '44' },
  India: { pattern: /^91(\d{10})$/, length: 10, code: '91' },
  Pakistan: { pattern: /^92(\d{10})$/, length: 10, code: '92' },
  Bangladesh: { pattern: /^880(\d{10})$/, length: 10, code: '880' },
  Brazil: { pattern: /^55(\d{10,11})$/, length: 10, code: '55' },
  Mexico: { pattern: /^52(\d{10})$/, length: 10, code: '52' },
  Germany: { pattern: /^49(\d{9,11})$/, length: 9, code: '49' },
  France: { pattern: /^33(\d{9})$/, length: 9, code: '33' },
  Canada: { pattern: /^1?(\d{10})$/, length: 10, code: '1' },
  Iran: { pattern: /^98(\d{9,10})$/, length: 10, code: '98' },
};

/**
 * Validates a phone number and returns formatted version
 * Handles various input formats: +1234567890, 1234567890, 0001234567890
 */
export function validatePhoneNumber(
  phoneNumber: string,
  countryCode?: string
): ValidationResult {
  try {
    // Remove common separators
    let cleaned = phoneNumber
      .replace(/[\s\-\(\)\.]/g, '')
      .replace(/^0+/, ''); // Remove leading zeros

    // Remove + if present
    if (cleaned.startsWith('+')) {
      cleaned = cleaned.substring(1);
    }

    let nationalNumber = cleaned; // The number WITHOUT country code

    // If no country code provided, try to detect
    if (!countryCode) {
      // Try to auto-detect based on patterns
      for (const [country, pattern] of Object.entries(COUNTRY_PATTERNS)) {
        const match = cleaned.match(pattern.pattern);
        if (match) {
          countryCode = pattern.code;
          // Extract national number from regex match (first capture group)
          nationalNumber = match[1] || cleaned.substring(pattern.code.length);
          break;
        }
      }
    }

    // If still no country code, default to detecting from number
    if (!countryCode) {
      // Assume first 1-3 digits are country code
      const firstThreeDigits = cleaned.substring(0, 3);
      const firstTwoDigits = cleaned.substring(0, 2);
      const firstOneDigit = cleaned.substring(0, 1);

      if (Object.values(COUNTRY_PATTERNS).some(p => p.code === firstThreeDigits)) {
        countryCode = firstThreeDigits;
        nationalNumber = cleaned.substring(3);
      } else if (Object.values(COUNTRY_PATTERNS).some(p => p.code === firstTwoDigits)) {
        countryCode = firstTwoDigits;
        nationalNumber = cleaned.substring(2);
      } else if (Object.values(COUNTRY_PATTERNS).some(p => p.code === firstOneDigit)) {
        countryCode = firstOneDigit;
        nationalNumber = cleaned.substring(1);
      } else {
        return {
          isValid: false,
          number: phoneNumber,
          countryCode: 'UNKNOWN',
          formattedNumber: '',
          error: 'Could not detect country code from number',
        };
      }
    }

    // Validate minimum length
    if (nationalNumber.length < 9) {
      return {
        isValid: false,
        number: phoneNumber,
        countryCode: countryCode || 'UNKNOWN',
        formattedNumber: '',
        error: 'Phone number too short',
      };
    }

    // Validate maximum length
    if (nationalNumber.length > 15) {
      return {
        isValid: false,
        number: phoneNumber,
        countryCode: countryCode || 'UNKNOWN',
        formattedNumber: '',
        error: 'Phone number too long',
      };
    }

    // Must contain only digits
    if (!/^\d+$/.test(nationalNumber)) {
      return {
        isValid: false,
        number: phoneNumber,
        countryCode: countryCode || 'UNKNOWN',
        formattedNumber: '',
        error: 'Phone number contains non-digit characters',
      };
    }

    // Formatted number with country code
    const formattedNumber = `${countryCode}${nationalNumber}`;

    return {
      isValid: true,
      number: phoneNumber,
      countryCode: countryCode,
      formattedNumber: formattedNumber,
    };
  } catch (error) {
    logger.error(`Error validating phone number: ${error}`);
    return {
      isValid: false,
      number: phoneNumber,
      countryCode: 'UNKNOWN',
      formattedNumber: '',
      error: `Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Validates multiple phone numbers
 */
export function validatePhoneNumbers(
  phoneNumbers: string[],
  countryCode?: string
): ValidationResult[] {
  return phoneNumbers.map(number => validatePhoneNumber(number, countryCode));
}

/**
 * Filters out invalid phone numbers from array
 */
export function filterValidPhoneNumbers(
  phoneNumbers: string[],
  countryCode?: string
): string[] {
  return validatePhoneNumbers(phoneNumbers, countryCode)
    .filter(result => result.isValid)
    .map(result => result.formattedNumber);
}

/**
 * Check if number is potentially WhatsApp-enabled
 * WhatsApp works with any valid phone number, but some checks:
 * - Must have valid format
 * - Should not be toll-free or VOIP (certain prefixes)
 */
export function isWhatsAppEligible(phoneNumber: string, countryCode?: string): boolean {
  const validation = validatePhoneNumber(phoneNumber, countryCode);
  
  if (!validation.isValid) {
    return false;
  }

  // Toll-free and service numbers that won't work on WhatsApp
  const tollFreePatterns = [
    /^1(800|888|877|866|855)/, // US toll-free
    /^44(800|844|845|870)/, // UK service numbers
    /^91(1200|1800)/, // India toll-free
  ];

  const number = validation.formattedNumber;
  const isBlacklisted = tollFreePatterns.some(pattern => pattern.test(number));

  return !isBlacklisted;
}

/**
 * Formats a phone number to standard format
 */
export function formatPhoneNumber(phoneNumber: string, countryCode?: string): string {
  const validation = validatePhoneNumber(phoneNumber, countryCode);
  return validation.isValid ? validation.formattedNumber : phoneNumber;
}

/**
 * Check multiple phone numbers for WhatsApp eligibility
 */
export function filterWhatsAppEligible(
  phoneNumbers: string[],
  countryCode?: string
): string[] {
  return phoneNumbers.filter(number => isWhatsAppEligible(number, countryCode));
}
