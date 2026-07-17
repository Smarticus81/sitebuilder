import {
  insertMessage,
  getMessageByLead,
  logEvent,
  type DB,
  type Lead,
  type Message,
  type WebsiteAudit,
} from '@storefront/db';
import type { LlmProvider } from '@storefront/llm';
import type { StorefrontConfig } from './config.js';
import { complianceFooter } from './compliance.js';
import { siteObservation } from './qualifier.js';
import { cityFrom } from './builder.js';
import { assignVariant } from './ab.js';

export interface DraftDeps {
  db: DB;
  llm: LlmProvider;
  config: StorefrontConfig;
}

/**
 * Draft a compliant outreach email for a lead whose demo is ready (Gate B has
 * passed). Writes status `draft` — NEVER sends. The body is stamped with the
 * sender identity, physical address, and a working unsubscribe link.
 */
export async function draftOutreach(deps: DraftDeps, lead: Lead): Promise<Message> {
  const { db, llm, config } = deps;
  if (!lead.contact_email) {
    throw new Error(
      `Lead ${lead.id} (${lead.name}) has no contact email — email outreach needs one ` +
        `(the 'none' segment is phone-first, handled in Phase 3).`,
    );
  }
  if (!lead.demo_url) {
    throw new Error(`Lead ${lead.id} (${lead.name}) has no demo_url — build the demo first.`);
  }

  const audit: WebsiteAudit | null = lead.audit_json
    ? (JSON.parse(lead.audit_json) as WebsiteAudit)
    : null;

  const draft = await llm.outreach({
    businessName: lead.name,
    city: cityFrom(lead.address),
    observation: siteObservation(audit),
    demoUrl: lead.demo_url,
    senderName: config.senderName,
    senderBusiness: config.senderBusiness,
  });

  const body = draft.body + complianceFooter(config, lead.contact_email);

  // A/B: subject style. Assignment is stable per lead and audit-logged; the
  // 'benefit' variant keeps the LLM subject, 'question' uses the alt style.
  const subjectVariant = assignVariant(db, 'subject-style', lead.id);
  const subject =
    subjectVariant === 'question'
      ? `Quick question about ${lead.name}'s website`
      : draft.subject;

  const message = insertMessage(db, {
    lead_id: lead.id,
    channel: 'email',
    subject,
    body,
    status: 'draft',
  });
  logEvent(db, 'outreach.drafted', lead.id, { message_id: message.id });
  return message;
}

export { getMessageByLead };
