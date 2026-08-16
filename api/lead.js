// Scorva website lead endpoint. Runs server-side on Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const hubspotToken = process.env.HUBSPOT_ACCESS_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;
  const notificationEmail = process.env.LEAD_NOTIFICATION_EMAIL;
  const fromEmail = process.env.LEAD_FROM_EMAIL || 'Scorva Projects <leads@scorvaprojects.com>';

  console.log('Scorva env status', {
    hubspot: Boolean(hubspotToken),
    resend: Boolean(resendApiKey),
    notificationEmail: Boolean(notificationEmail),
    fromEmail: Boolean(fromEmail)
  });

  if (!hubspotToken) return res.status(500).json({ ok: false, error: 'HubSpot integration is not configured yet.' });

  const { firstName='', lastName='', email='', phone='', zip='', projectType='', paintingType='', budget='', start='', details='' } = req.body || {};
  if (!firstName || !lastName || !email || !phone || !zip || !projectType) return res.status(400).json({ ok:false, error:'Please complete the required fields.' });

  const hubspotHeaders = { Authorization: `Bearer ${hubspotToken}`, 'Content-Type': 'application/json' };
  async function hs(path, options={}) {
    const r = await fetch(`https://api.hubapi.com${path}`, { ...options, headers:{...hubspotHeaders,...(options.headers||{})} });
    const text = await r.text(); let data={};
    try { data=text?JSON.parse(text):{}; } catch { data={raw:text}; }
    if (!r.ok) { const e=new Error(data?.message||`HubSpot request failed (${r.status})`); e.data=data; throw e; }
    return data;
  }

  async function sendLeadEmail({ projectLabel, dealId }) {
    if (!resendApiKey || !notificationEmail) {
      console.warn('Scorva notification skipped', { resendApiKey: Boolean(resendApiKey), notificationEmail: Boolean(notificationEmail) });
      return { skipped: true };
    }

    const safe = (v='') => String(v)
      .replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
      .replaceAll('"','&quot;').replaceAll("'",'&#039;');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">
        <h2 style="margin-bottom:6px">New Scorva Project Request</h2>
        <p style="margin-top:0;color:#666">A new homeowner request was submitted on ScorvaProjects.com.</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Name</b></td><td style="padding:8px;border-bottom:1px solid #eee">${safe(firstName)} ${safe(lastName)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Phone</b></td><td style="padding:8px;border-bottom:1px solid #eee"><a href="tel:${safe(phone)}">${safe(phone)}</a></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Email</b></td><td style="padding:8px;border-bottom:1px solid #eee"><a href="mailto:${safe(email)}">${safe(email)}</a></td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>ZIP</b></td><td style="padding:8px;border-bottom:1px solid #eee">${safe(zip)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Project</b></td><td style="padding:8px;border-bottom:1px solid #eee">${safe(projectLabel)}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Budget</b></td><td style="padding:8px;border-bottom:1px solid #eee">${safe(budget || 'Not provided')}</td></tr>
          <tr><td style="padding:8px;border-bottom:1px solid #eee"><b>Preferred start</b></td><td style="padding:8px;border-bottom:1px solid #eee">${safe(start || 'Not provided')}</td></tr>
          <tr><td style="padding:8px;vertical-align:top"><b>Details</b></td><td style="padding:8px">${safe(details || 'Not provided')}</td></tr>
        </table>
        <p style="margin-top:24px"><a href="https://app.hubspot.com/contacts/247060573/record/0-3/${encodeURIComponent(dealId)}" style="background:#111;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">Open Deal in HubSpot</a></p>
      </div>`;

    console.log('Scorva attempting Resend email', { to: notificationEmail, from: fromEmail });
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: fromEmail,
        to: [notificationEmail],
        subject: `New Scorva Lead: ${firstName} ${lastName} - ${projectLabel}`,
        html,
        reply_to: email
      })
    });

    const text = await r.text(); let data={};
    try { data=text?JSON.parse(text):{}; } catch { data={raw:text}; }
    console.log('Scorva Resend response', { status: r.status, ok: r.ok, data });
    if (!r.ok) { const e=new Error(data?.message||`Resend failed (${r.status})`); e.data=data; throw e; }
    return data;
  }

  try {
    let contactId;
    const search = await hs('/crm/v3/objects/contacts/search', { method:'POST', body:JSON.stringify({filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:email}]}],properties:['email'],limit:1}) });
    const contactProps={firstname:firstName,lastname:lastName,phone,zip};
    if (search.total>0) {
      contactId=search.results[0].id;
      await hs(`/crm/v3/objects/contacts/${contactId}`, {method:'PATCH',body:JSON.stringify({properties:contactProps})});
    } else {
      const contact=await hs('/crm/v3/objects/contacts',{method:'POST',body:JSON.stringify({properties:{...contactProps,email}})});
      contactId=contact.id;
    }

    const projectLabel=projectType==='Painting'&&paintingType?`Painting - ${paintingType}`:projectType;
    const description=[`Source: ScorvaProjects.com`,`Project ZIP: ${zip}`,`Project Type: ${projectLabel}`,`Budget: ${budget||'Not provided'}`,`Preferred Start: ${start||'Not provided'}`,`Project Details: ${details||'Not provided'}`].join('\n');
    const deal=await hs('/crm/v3/objects/deals',{method:'POST',body:JSON.stringify({properties:{dealname:`${firstName} ${lastName} - ${projectLabel}`,pipeline:'default',dealstage:'appointmentscheduled',description,hubspot_owner_id:'97266463'},associations:[{to:{id:contactId},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:3}]}]})});

    let notificationSent = false;
    try {
      const emailResult = await sendLeadEmail({ projectLabel, dealId: deal.id });
      notificationSent = !emailResult?.skipped;
    } catch (notifyError) {
      console.error('Scorva notification error', notifyError?.data || notifyError);
    }

    return res.status(200).json({ok:true,dealId:deal.id,notificationSent});
  } catch(error) {
    console.error('Scorva lead error',error?.data||error);
    return res.status(500).json({ok:false,error:'We could not submit your request. Please try again.'});
  }
}
