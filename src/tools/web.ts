import { tool } from 'ai';
import { z } from 'zod';

const MAX_CONTENT_CHARS = 20_000;

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const webFetchTool = tool({
  description:
    'Fetch the text content of an HTTP/HTTPS URL (documentation, API references, etc.).',
  parameters: z.object({
    url: z.string().describe('The HTTP or HTTPS URL to fetch'),
  }),
  execute: async ({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return `Error: Invalid URL: ${url}`;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Error: Unsupported URL scheme "${parsed.protocol}". Only http and https are allowed.`;
    }

    try {
      const response = await fetch(parsed.toString(), {
        headers: {
          'User-Agent': 'Cortex-CLI/0.2',
          Accept: 'text/plain, text/markdown, text/html, application/json;q=0.9, */*;q=0.8',
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        return `HTTP ${response.status} ${response.statusText} fetching ${url}`;
      }

      const contentType = response.headers.get('content-type') ?? '';
      const raw = await response.text();
      const text = contentType.includes('html') ? htmlToText(raw) : raw.trim();

      if (text.length > MAX_CONTENT_CHARS) {
        return `${text.slice(0, MAX_CONTENT_CHARS)}\n\n[... truncated at ${MAX_CONTENT_CHARS} characters]`;
      }
      return text || '(empty response)';
    } catch (err) {
      return `Error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
