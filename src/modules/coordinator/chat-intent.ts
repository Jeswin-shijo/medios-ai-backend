/** Turns a staff question into an intent and, when it names one, a patient or case. Pure: no Nest, no database. */

export type ChatIntentKind = 'case-status' | 'allocate-bed' | 'discharge-status' | 'agent-workload' | 'approvals' | 'overdue' | 'unknown';

export interface ChatIntent {
  kind: ChatIntentKind;
  ref?: { kind: 'uhid' | 'case' | 'name'; value: string };
}

const UHID = /MHK\d{9}(?!\d)/i;
const CASE_NUMBER = /CASE-\d+/i;
const STOP_WORDS = new Set(['the', 'a', 'an', 'me', 'us', 'this', 'that', 'it', 'patient', 'case', 'today', 'all', 'each', 'them', 'now', 'please']);
const TRAILING_WORDS = new Set(['status', 'request', 'requests', 'please', 'now', 'today']);
const ARTICLES = new Set(['the', 'a', 'an']);
/** Questions are short; anything past this is ignored, which also bounds the work below. */
const MAX_QUESTION_LENGTH = 500;
const EDGE = new Set(['"', "'", '(', ')', '.', ',', '?', '!', ';', ':']);

/** Trims whitespace and the punctuation a question wraps a name in, with no backtracking regex. */
function trimEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && (EDGE.has(text[start]) || text[start].trim() === '')) start += 1;
  while (end > start && (EDGE.has(text[end - 1]) || text[end - 1].trim() === '')) end -= 1;
  return text.slice(start, end);
}

/** The words after the last "for" or "of", else after "where is", trimmed. Empty when there are none. */
function nameFrom(text: string): string {
  const afterLast = (re: RegExp): string | null => {
    const all = [...text.matchAll(re)];
    return all.length ? text.slice((all[all.length - 1].index ?? 0) + all[all.length - 1][0].length) : null;
  };
  const raw = trimEdges(afterLast(/\b(?:for|of)\s/gi) ?? afterLast(/\bwhere is\s/gi) ?? '');
  const words = raw.split(/\s+/).filter(Boolean);
  while (words.length && TRAILING_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  while (words.length && ARTICLES.has(words[0].toLowerCase())) words.shift();
  const name = words.join(' ');
  return STOP_WORDS.has(name.toLowerCase()) ? '' : name;
}

function kindOf(text: string): ChatIntentKind {
  const t = text.toLowerCase();
  if (/\ballocate\b/.test(t) || /\bbed for\b/.test(t)) return 'allocate-bed';
  if (/\bdischarge/.test(t)) return 'discharge-status';
  if (/\bworkload\b|\bagents\b/.test(t)) return 'agent-workload';
  if (/\bapproval|\bpending\b/.test(t)) return 'approvals';
  if (/\boverdue\b|\blate\b/.test(t)) return 'overdue';
  if (/\bstatus\b|\bwhere\b/.test(t)) return 'case-status';
  return 'unknown';
}

export function resolveQuestion(input: string): ChatIntent {
  const text = (typeof input === 'string' ? input : '').slice(0, MAX_QUESTION_LENGTH);
  const kind = kindOf(text);
  if (kind === 'unknown') return { kind };
  const uhid = text.match(UHID);
  if (uhid) return { kind, ref: { kind: 'uhid', value: uhid[0].toUpperCase() } };
  const caseNo = text.match(CASE_NUMBER);
  if (caseNo) return { kind, ref: { kind: 'case', value: caseNo[0].toUpperCase() } };
  const name = nameFrom(text);
  return name ? { kind, ref: { kind: 'name', value: name } } : { kind };
}
