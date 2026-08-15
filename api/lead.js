// Scorva website lead endpoint. This file runs server-side on Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'HubSpot integration is not configured yet.' });

  const { firstName='', lastName='', email='', phone='', zip='', projectType='', paintingType='', budget='', start='', details='' } = req.body || {};
  if (!firstName || !lastName || !email || !phone || !zip || !projectType) return res.status(400).json({ ok:false, error:'Please complete the required fields.' });

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  async function hs(path, options={}) {
    const r = await fetch(`https://api.hubapi.com${path}`, { ...options, headers:{...headers,...(options.headers||{})} });
    const text = await r.text(); let data={};
    try { data=text?JSON.parse(text):{}; } catch { data={raw:text}; }
    if (!r.ok) { const e=new Error(data?.message||`HubSpot request failed (${r.status})`); e.data=data; throw e; }
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
    return res.status(200).json({ok:true,dealId:deal.id});
  } catch(error) {
    console.error('Scorva lead error',error?.data||error);
    return res.status(500).json({ok:false,error:'We could not submit your request. Please try again.'});
  }
}
