// Scorva website lead endpoint. Runs server-side on Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ok:false,error:'Method not allowed'}); }
  res.setHeader('Cache-Control','no-store');
  const hubspotToken=process.env.HUBSPOT_ACCESS_TOKEN;
  const resendApiKey=process.env.RESEND_API_KEY;
  const notificationEmail=process.env.LEAD_NOTIFICATION_EMAIL;
  const fromEmail=process.env.LEAD_FROM_EMAIL||'Scorva Projects <leads@scorvaprojects.com>';
  if(!hubspotToken) return res.status(500).json({ok:false,error:'Lead service is temporarily unavailable.'});

  const body=req.body||{};
  const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
  const firstName=clean(body.firstName,60),lastName=clean(body.lastName,60),email=clean(body.email,120).toLowerCase(),phone=clean(body.phone,30),zip=clean(body.zip,5),projectType=clean(body.projectType,80),paintingType=clean(body.paintingType,80),budget=clean(body.budget,80),start=clean(body.start,80),details=clean(body.details,2000),homeowner=clean(body.homeowner,40),website=clean(body.website,100);
  if(website) return res.status(200).json({ok:true}); // honeypot
  if(!firstName||!lastName||!email||!phone||!zip||!projectType||!homeowner) return res.status(400).json({ok:false,error:'Please complete the required fields.'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ok:false,error:'Please enter a valid email address.'});
  if(!/^\d{5}$/.test(zip)) return res.status(400).json({ok:false,error:'Please enter a valid 5-digit ZIP code.'});
  const allowedProjects=['Kitchen Renovation','Bathroom Renovation','Flooring','Painting','Multiple / Whole-home'];
  if(!allowedProjects.includes(projectType)) return res.status(400).json({ok:false,error:'Please select a valid project type.'});

  const hubspotHeaders={Authorization:`Bearer ${hubspotToken}`,'Content-Type':'application/json'};
  async function hs(path,options={}){const r=await fetch(`https://api.hubapi.com${path}`,{...options,headers:{...hubspotHeaders,...(options.headers||{})}});const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!r.ok){const e=new Error(data?.message||`HubSpot request failed (${r.status})`);e.data=data;throw e}return data}
  const safe=(v='')=>String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  async function sendLeadEmail({projectLabel,dealId}){
    if(!resendApiKey||!notificationEmail) return {skipped:true};
    const html=`<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111"><h2>New Scorva Project Request</h2><p style="color:#666">A homeowner project request was submitted on ScorvaProjects.com.</p><table style="border-collapse:collapse;width:100%"><tr><td><b>Name</b></td><td>${safe(firstName)} ${safe(lastName)}</td></tr><tr><td><b>Phone</b></td><td><a href="tel:${safe(phone)}">${safe(phone)}</a></td></tr><tr><td><b>Email</b></td><td><a href="mailto:${safe(email)}">${safe(email)}</a></td></tr><tr><td><b>ZIP</b></td><td>${safe(zip)}</td></tr><tr><td><b>Homeowner</b></td><td>${safe(homeowner)}</td></tr><tr><td><b>Project</b></td><td>${safe(projectLabel)}</td></tr><tr><td><b>Budget</b></td><td>${safe(budget||'Not provided')}</td></tr><tr><td><b>Preferred start</b></td><td>${safe(start||'Not provided')}</td></tr><tr><td><b>Details</b></td><td>${safe(details||'Not provided')}</td></tr></table><p style="margin-top:24px"><a href="https://app.hubspot.com/contacts/247060573/record/0-3/${encodeURIComponent(dealId)}" style="background:#111;color:white;padding:12px 16px;border-radius:6px;text-decoration:none">Open Deal in HubSpot</a></p></div>`;
    const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendApiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:fromEmail,to:[notificationEmail],subject:`New Scorva Lead: ${firstName} ${lastName} - ${projectLabel}`,html,reply_to:email})});
    const text=await r.text();let data={};try{data=text?JSON.parse(text):{}}catch{data={raw:text}}if(!r.ok){const e=new Error(data?.message||`Resend failed (${r.status})`);e.data=data;throw e}return data;
  }
  try{
    let contactId;
    const search=await hs('/crm/v3/objects/contacts/search',{method:'POST',body:JSON.stringify({filterGroups:[{filters:[{propertyName:'email',operator:'EQ',value:email}]}],properties:['email'],limit:1})});
    const contactProps={firstname:firstName,lastname:lastName,phone,zip};
    if(search.total>0){contactId=search.results[0].id;await hs(`/crm/v3/objects/contacts/${contactId}`,{method:'PATCH',body:JSON.stringify({properties:contactProps})})}else{const contact=await hs('/crm/v3/objects/contacts',{method:'POST',body:JSON.stringify({properties:{...contactProps,email}})});contactId=contact.id}
    const projectLabel=projectType==='Painting'&&paintingType?`Painting - ${paintingType}`:projectType;
    const description=[`Source: ScorvaProjects.com`,`Project ZIP: ${zip}`,`Homeowner Status: ${homeowner}`,`Project Type: ${projectLabel}`,`Budget: ${budget||'Not provided'}`,`Preferred Start: ${start||'Not provided'}`,`Project Details: ${details||'Not provided'}`].join('\n');
    const deal=await hs('/crm/v3/objects/deals',{method:'POST',body:JSON.stringify({properties:{dealname:`${firstName} ${lastName} - ${projectLabel}`,pipeline:'default',dealstage:'appointmentscheduled',description,hubspot_owner_id:'97266463'},associations:[{to:{id:contactId},types:[{associationCategory:'HUBSPOT_DEFINED',associationTypeId:3}]}]})});
    let notificationSent=false;try{const result=await sendLeadEmail({projectLabel,dealId:deal.id});notificationSent=!result?.skipped}catch(e){console.error('Scorva notification failed',{message:e?.message})}
    return res.status(200).json({ok:true,dealId:deal.id,notificationSent});
  }catch(error){console.error('Scorva lead submission failed',{message:error?.message});return res.status(500).json({ok:false,error:'We could not submit your request. Please try again.'})}
}
