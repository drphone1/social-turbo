export interface TextIntegrityWarning {
  field: string;
  message: string;
  suspiciousSequenceCount: number;
  questionMarkRatio: number;
}

function countQuestionMarks(value: string) {
  return (value.match(/\?/g) || []).length;
}

function countSuspiciousSequences(value: string) {
  return (value.match(/\?{3,}/g) || []).length;
}

function hasArabicOrPersianCharacters(value: string) {
  return /[\u0600-\u06FF]/.test(value);
}

export function analyzeSuspiciousText(value: string | null | undefined, field: string): TextIntegrityWarning | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const suspiciousSequenceCount = countSuspiciousSequences(trimmed);
  const questionMarkRatio = countQuestionMarks(trimmed) / Math.max(trimmed.length, 1);

  const looksCorrupted = suspiciousSequenceCount > 0 && !hasArabicOrPersianCharacters(trimmed);
  const hasHeavyQuestionMarkNoise = questionMarkRatio >= 0.25 && trimmed.length >= 8;

  if (!looksCorrupted && !hasHeavyQuestionMarkNoise) {
    return null;
  }

  return {
    field,
    message: `Potential text encoding issue detected in ${field}. The text contains suspicious replacement question marks and may have been pasted or transmitted with a non-UTF-8 path.`,
    suspiciousSequenceCount,
    questionMarkRatio: Number(questionMarkRatio.toFixed(3)),
  };
}

export function collectCampaignTextWarnings(input: {
  name?: string | null;
  messageTemplate?: string | null;
}) {
  return [
    analyzeSuspiciousText(input.name, 'name'),
    analyzeSuspiciousText(input.messageTemplate, 'messageTemplate'),
  ].filter((warning): warning is TextIntegrityWarning => Boolean(warning));
}