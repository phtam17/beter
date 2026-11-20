export async function sendSupportRequest(payload,{fetchImpl=globalThis.fetch}={}){
 const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
 try{
  const response=await fetchImpl('/api/support',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
  let result;try{result=await response.json();}catch{return{ok:false,message:'Your request has not been confirmed as sent. Please try again later.'};}
  if(response.status===202&&result?.accepted===true&&/^BTR-[a-f0-9-]{36}$/.test(result.reference||''))return{ok:true,reference:result.reference};
  if(response.status===429)return{ok:false,message:'Too many support requests. Please wait before trying again.'};
  if(response.status===400||response.status===413)return{ok:false,message:'Check your email and shorten your message, then try again. Your request has not been confirmed as sent.'};
  return{ok:false,message:'Your request has not been confirmed as sent. Please try again later.'};
 }catch{return{ok:false,message:'Your request has not been confirmed as sent. Check your connection and try again.'};}finally{clearTimeout(timeout);}
}
export function initializeSupportForm(document,location,fetchImpl=globalThis.fetch){
 const form=document.querySelector('#support-form');if(!form)return;
 const fields=document.querySelector('#support-fields'),email=document.querySelector('#support-email'),message=document.querySelector('#support-message'),status=document.querySelector('#support-status'),button=form.querySelector('button[type="submit"]'),dirty=new WeakSet();let sending=false;
 const topic=new URLSearchParams(location.search).get('topic');if(['general','privacy','delete-account'].includes(topic))form.querySelector(`input[name="topic"][value="${topic}"]`).checked=true;
 const update=(field,invalid)=>{const error=document.getElementById(field.dataset.error),ids=(field.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==error.id);field.setAttribute('aria-invalid',String(invalid));error.hidden=!invalid;if(invalid)ids.push(error.id);field.setAttribute('aria-describedby',ids.join(' '));};
 for(const field of [email,message]){field.addEventListener('input',()=>{dirty.add(field);field.setCustomValidity('');if(field.validity.valid)update(field,false);});field.addEventListener('blur',()=>{if(dirty.has(field))update(field,!field.validity.valid);});field.addEventListener('invalid',()=>update(field,true));}
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(sending)return;const payload={email:email.value.trim(),topic:form.querySelector('input[name="topic"]:checked').value,message:message.value.trim()};
  if([...payload.message].length<10||[...payload.message].length>4000||new TextEncoder().encode(JSON.stringify(payload)).byteLength>8192){message.setCustomValidity('Please enter a shorter message of 10–4,000 characters.');update(message,true);message.reportValidity();message.focus();return;}
  if(!form.reportValidity())return;sending=true;button.disabled=true;button.textContent='Sending request…';form.setAttribute('aria-busy','true');status.textContent='';
  const result=await sendSupportRequest(payload,{fetchImpl});form.removeAttribute('aria-busy');sending=false;
  if(result.ok){button.textContent='Request accepted';status.textContent=`Accepted for operator review. Reference: ${result.reference}. Save this reference. This page does not send an email receipt or confirm account deletion.`;}else{button.disabled=false;button.textContent='Send request';status.textContent=result.message;}
 });
 fields.disabled=false;
}
if(typeof document!=='undefined')initializeSupportForm(document,location);
