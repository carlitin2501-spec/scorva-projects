import { createHash } from 'node:crypto';

// Best-effort warm-instance throttling. Vercel instances do not share memory, so this
// supplements (rather than replaces) platform-level rate limiting if added later.
const requestBuckets = globalThis.__scorvaLeadBuckets || new Map();
globalThis.__scorvaLeadBuckets = requestBuckets;

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_REQUESTS = 8;
const MAX_BODY_BYTES = 20_000;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEAL_FINGERPRINT_PROPERTY = 'scorva_submission_fingerprint';
const INITIAL_DEAL_STAGE = process.env.HUBSPOT_INITIAL_DEAL_STAGE || 'appointmentscheduled';

function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers?.['x-real-ip'] || 'unknown');
}

function isRateLimited(req) {
  const now = Date.now();
  const key = createHash('sha256').update(clientIp(req)).digest('hex');
  const current = requestBuckets.get(key);

  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  requestBuckets.set(key, current);

  if (requestBuckets.size > 500) {
    for (const [bucketKey, bucket] of requestBuckets) {
      if (now - bucket.startedAt >= RATE_WINDOW_MS) requestBuckets.delete(bucketKey);
    }
  }

  return current.count > RATE_MAX_REQUESTS;
}

function isSameOrigin(req) {
  const origin = String(req.headers?.origin || '').trim();
  if (!origin) return true;

  try {
    const originHost = new URL(origin).host.toLowerCase();
    const requestHost = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '')
      .split(',')[0]
      .trim()
      .toLowerCase();
    return Boolean(requestHost) && originHost === requestHost;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return res.status(415).json({ ok: false, error: 'Unsupported request format.' });
  }

  const contentLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return res.status(413).json({ ok: false, error: 'Request is too large.' });
  }

  if (!isSameOrigin(req)) {
    return res.status(403).json({ ok: false, error: 'Request origin is not allowed.' });
  }

  if (isRateLimited(req)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE_WINDOW_MS / 1000)));
    return res.status(429).json({ ok: false, error: 'Too many requests. Please try again later.' });
  }

  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;
  const notificationEmail = process.env.LEAD_NOTIFICATION_EMAIL;
  const fromEmail = process.env.LEAD_FROM_EMAIL || 'Scorva Projects <leads@scorvaprojects.com>';
  const isTestSubmission = process.env.VERCEL_ENV === 'preview';
  const testPrefix = isTestSubmission ? '[TEST] ' : '';

  if (!hubspotToken) {
    return res.status(500).json({ ok: false, error: 'Lead service is temporarily unavailable.' });
  }

  const body = req.body || {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ ok: false, error: 'Invalid request body.' });
  }

  const clean = (value, max = 500) => String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, max);
  const normalize = (value = '') => clean(value, 2000).toLowerCase().replace(/\s+/g, ' ');

  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const email = clean(body.email, 120).toLowerCase();
  const phone = clean(body.phone, 30);
  const zip = clean(body.zip, 5);
  const projectType = clean(body.projectType, 80);
  const paintingType = clean(body.paintingType, 80);
  const budget = clean(body.budget, 80);
  const start = clean(body.start, 80);
  const details = clean(body.details, 2000);
  const homeowner = clean(body.homeowner, 40);
  const website = clean(body.website, 100);
  const sourcePage = clean(body.sourcePage, 300);
  const referrer = clean(body.referrer || req.headers?.referer, 300);
  const utmSource = clean(body.utmSource, 120);
  const utmMedium = clean(body.utmMedium, 120);
  const utmCampaign = clean(body.utmCampaign, 160);
  const utmContent = clean(body.utmContent, 160);
  const utmTerm = clean(body.utmTerm, 160);

  if (website) return res.status(200).json({ ok: true });

  if (!firstName || !lastName || !email || !phone || !zip || !projectType || !homeowner) {
    return res.status(400).json({ ok: false, error: 'Please complete the required fields.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid email address.' });
  }

  const phoneDigits = phone.replace(/\D/g, '');
  if (phoneDigits.length < 10 || phoneDigits.length > 15) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid phone number.' });
  }
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ ok: false, error: 'Please enter a valid 5-digit ZIP code.' });
  }

  const allowedProjects = ['Kitchen Renovation', 'Bathroom Renovation', 'Flooring', 'Painting', 'Multiple / Whole-home'];
  const allowedPaintingTypes = ['Interior', 'Exterior', 'Both Interior & Exterior'];
  const allowedHomeowner = ['Yes', 'No', 'Purchasing / under contract'];
  const allowedBudgets = ['Not sure yet', 'Under $5,000', '$5,000–$15,000', '$15,000–$30,000', '$30,000–$50,000', '$50,000+'];
  const allowedStarts = ['ASAP', 'Within 30 days', '1–3 months', '3–6 months', '6+ months'];

  if (!allowedProjects.includes(projectType)) {
    return res.status(400).json({ ok: false, error: 'Please select a valid project type.' });
  }
  if (projectType === 'Painting' && !allowedPaintingTypes.includes(paintingType)) {
    return res.status(400).json({ ok: false, error: 'Please select a valid painting type.' });
  }
  if (!allowedHomeowner.includes(homeowner)) {
    return res.status(400).json({ ok: false, error: 'Please select a valid homeowner status.' });
  }
  if (budget && !allowedBudgets.includes(budget)) {
    return res.status(400).json({ ok: false, error: 'Please select a valid budget range.' });
  }
  if (start && !allowedStarts.includes(start)) {
    return res.status(400).json({ ok: false, error: 'Please select a valid preferred start.' });
  }

  const hubspotHeaders = {
    Authorization: `Bearer ${hubspotToken}`,
    'Content-Type': 'application/json'
  };

  async function hs(path, options = {}) {
    const response = await fetch(`https://api.hubapi.com${path}`, {
      ...options,
      headers: { ...hubspotHeaders, ...(options.headers || {}) },
      signal: AbortSignal.timeout(12_000)
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(data?.message || `HubSpot request failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  const safe = (value = '') => String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');

  const projectLabel = projectType === 'Painting' ? `Painting - ${paintingType}` : projectType;
  // Dedupe identity intentionally excludes mutable qualification data (budget, timing,
  // and free-text details). Same client + ZIP + project should be one lead within 24h,
  // while a different project type remains a valid separate opportunity.
  const fingerprintSource = [email, zip, projectLabel].map(normalize).join('|');
  const fingerprintHash = createHash('sha256').update(fingerprintSource).digest('hex');
  const fingerprintLine = `Scorva Fingerprint: ${fingerprintHash}`;

  const attribution = [
    utmSource && `UTM Source: ${utmSource}`,
    utmMedium && `UTM Medium: ${utmMedium}`,
    utmCampaign && `UTM Campaign: ${utmCampaign}`,
    utmContent && `UTM Content: ${utmContent}`,
    utmTerm && `UTM Term: ${utmTerm}`,
    sourcePage && `Landing Page: ${sourcePage}`,
    referrer && `Referrer: ${referrer}`
  ].filter(Boolean);

  const sourceSummary = utmSource
    ? [utmSource, utmMedium, utmCampaign].filter(Boolean).join(' / ')
    : (referrer || 'Direct / unknown');

  async function sendLeadEmail({ dealId }) {
    if (!resendApiKey || !notificationEmail) return { skipped: true };

    const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111"><h2>${safe(testPrefix)}New Scorva Project Request</h2><p style="color:#666">A homeowner project request was submitted on ScorvaProjects.com.</p><table style="border-collapse:collapse;width:100%"><tr><td><b>Name</b></td><td>${safe(firstName)} ${safe(lastName)}</td></tr><tr><td><b>Phone</b></td><td><a href="tel:${safe(phone)}">${safe(phone)}</a></td></tr><tr><td><b>Email</b></td><td><a href="mailto:${safe(email)}">${safe(email)}</a></td></tr><tr><td><b>ZIP</b></td><td>${safe(zip)}</td></tr><tr><td><b>Homeowner</b></td><td>${safe(homeowner)}</td></tr><tr><td><b>Project</b></td><td>${safe(projectLabel)}</td></tr><tr><td><b>Budget</b></td><td>${safe(budget || 'Not provided')}</td></tr><tr><td><b>Preferred start</b></td><td>${safe(start || 'Not provided')}</td></tr><tr><td><b>Details</b></td><td>${safe(details || 'Not provided')}</td></tr><tr><td><b>Lead source</b></td><td>${safe(sourceSummary)}</td></tr></table><p style="margin-top:24px"><a href="https://app.hubspot.com/contacts/247060573/record/0-3/${encodeURIComponent(dealId)}" style="background:#111;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">Open Deal in HubSpot</a></p></div>`;

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [notificationEmail],
        subject: `${testPrefix}New Scorva Lead: ${firstName} ${lastName} - ${projectLabel}`,
        html,
        reply_to: email
      }),
      signal: AbortSignal.timeout(10_000)
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const error = new Error(data?.message || `Resend failed (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  async function ensureFingerprintProperty() {
    try {
      const property = await hs(`/crm/v3/properties/deals/${DEAL_FINGERPRINT_PROPERTY}`);
      if (!property?.hasUniqueValue) {
        const error = new Error(`${DEAL_FINGERPRINT_PROPERTY} exists but is not unique`);
        error.code = 'FINGERPRINT_PROPERTY_NOT_UNIQUE';
        throw error;
      }
      return property;
    } catch (error) {
      if (error?.status !== 404) throw error;
    }

    try {
      return await hs('/crm/v3/properties/deals', {
        method: 'POST',
        body: JSON.stringify({
          groupName: 'dealinformation',
          name: DEAL_FINGERPRINT_PROPERTY,
          label: 'Scorva Submission Fingerprint',
          description: 'Server-generated unique key used to prevent duplicate Scorva lead deals.',
          type: 'string',
          fieldType: 'text',
          hasUniqueValue: true,
          hidden: false,
          formField: false
        })
      });
    } catch (error) {
      // Two cold instances can try to provision the property simultaneously. If one wins,
      // re-read and proceed. Any other failure is configuration-critical and must fail closed.
      if (error?.status === 409) {
        const property = await hs(`/crm/v3/properties/deals/${DEAL_FINGERPRINT_PROPERTY}`);
        if (property?.hasUniqueValue) return property;
      }
      throw error;
    }
  }

  async function getDealByFingerprint() {
    try {
      return await hs(`/crm/v3/objects/deals/${encodeURIComponent(fingerprintHash)}?idProperty=${DEAL_FINGERPRINT_PROPERTY}&properties=dealname,description,createdate`);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  async function releaseExpiredFingerprint(deal) {
    const createdAt = Date.parse(deal?.properties?.createdate || '');
    if (!createdAt || Date.now() - createdAt < DEDUPE_WINDOW_MS) return false;

    await hs(`/crm/v3/objects/deals/${deal.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [DEAL_FINGERPRINT_PROPERTY]: '' } })
    });
    return true;
  }

  async function getContactByEmail() {
    try {
      return await hs(`/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email&properties=email`);
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  async function upsertContact() {
    const contactProps = { firstname: firstName, lastname: lastName, phone, zip };
    let contact = await getContactByEmail();

    if (contact) {
      await hs(`/crm/v3/objects/contacts/${contact.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: contactProps })
      });
      return contact.id;
    }

    try {
      contact = await hs('/crm/v3/objects/contacts', {
        method: 'POST',
        body: JSON.stringify({ properties: { ...contactProps, email } })
      });
      return contact.id;
    } catch (error) {
      // Contact email is unique in HubSpot. Concurrent first submissions for the same new
      // email can race here; recover by reading the contact that the other request created.
      if (error?.status === 409) {
        contact = await getContactByEmail();
        if (contact?.id) {
          await hs(`/crm/v3/objects/contacts/${contact.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ properties: contactProps })
          });
          return contact.id;
        }
      }
      throw error;
    }
  }

  try {
    await ensureFingerprintProperty();

    // Fast path for retries after a completed request. The unique property lookup is direct
    // and does not depend on contact/deal association propagation or CRM search indexing.
    const existingDeal = await getDealByFingerprint();
    if (existingDeal) {
      const released = await releaseExpiredFingerprint(existingDeal);
      if (!released) {
        return res.status(200).json({
          ok: true,
          dealId: existingDeal.id,
          duplicate: true,
          notificationSent: false
        });
      }
    }

    const contactId = await upsertContact();

    const description = [
      'Source: ScorvaProjects.com',
      isTestSubmission && 'Submission Environment: Preview / Test',
      ...attribution,
      `Project ZIP: ${zip}`,
      `Homeowner Status: ${homeowner}`,
      `Project Type: ${projectLabel}`,
      `Budget: ${budget || 'Not provided'}`,
      `Preferred Start: ${start || 'Not provided'}`,
      `Project Details: ${details || 'Not provided'}`,
      fingerprintLine
    ].filter(Boolean).join('\n');

    let deal;
    try {
      deal = await hs('/crm/v3/objects/deals', {
        method: 'POST',
        body: JSON.stringify({
          properties: {
            dealname: `${testPrefix}${firstName} ${lastName} - ${projectLabel}`,
            pipeline: 'default',
            dealstage: INITIAL_DEAL_STAGE,
            description,
            hubspot_owner_id: '97266463',
            [DEAL_FINGERPRINT_PROPERTY]: fingerprintHash
          },
          associations: [{
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }]
          }]
        })
      });
    } catch (error) {
      if (error?.status === 409) {
        const duplicate = await getDealByFingerprint();
        if (duplicate) {
          return res.status(200).json({
            ok: true,
            dealId: duplicate.id,
            duplicate: true,
            notificationSent: false
          });
        }
      }
      throw error;
    }

    let notificationSent = false;
    try {
      const result = await sendLeadEmail({ dealId: deal.id });
      notificationSent = !result?.skipped;
    } catch (error) {
      console.error('Scorva notification failed', {
        dealId: deal.id,
        status: error?.status,
        message: error?.message
      });
    }

    return res.status(200).json({
      ok: true,
      dealId: deal.id,
      duplicate: false,
      notificationSent
    });
  } catch (error) {
    const configurationFailure = error?.code === 'FINGERPRINT_PROPERTY_NOT_UNIQUE'
      || (error?.status === 403 && String(error?.data?.message || '').toLowerCase().includes('scope'));

    console.error('Scorva lead submission failed', {
      status: error?.status,
      code: error?.code,
      correlationId: error?.data?.correlationId,
      message: error?.message
    });

    if (configurationFailure) {
      return res.status(503).json({
        ok: false,
        error: 'Lead service configuration needs attention. Please try again shortly.'
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'We could not submit your request. Please try again.'
    });
  }
}
