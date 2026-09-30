const section=document.querySelector('[data-flow]');
const base=section.dataset.base+'/'+encodeURIComponent(section.dataset.flow);
const form=document.querySelector('#connect-form'),error=document.querySelector('#error');
async function action(name,data={}){
  const r=await fetch(base+'/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,csrf:section.dataset.csrf}),credentials:'same-origin'});
  const body=await r.json();if(!r.ok||body.error)throw new Error(body.message||'The connection could not finish. Start again from ChatGPT.');return body;
}
function showCode(r){
  document.querySelector('#user-code').textContent=r.userCode||'';
  const link=document.querySelector('#microsoft-link');link.hidden=!r.verificationUrl;
  if(r.verificationUrl){link.href=r.verificationUrl;document.querySelector('#status').textContent='Waiting for sign-in…';}
}
async function poll(){
  try{const r=await action('poll');if(r.redirect){window.location.assign(r.redirect);return;}showCode(r);setTimeout(poll,Math.max(5000,r.retryAfterMs||5000));}
  catch(e){error.textContent=e.message;document.querySelector('#status').textContent='Sign-in stopped.';}
}
form.addEventListener('submit',async e=>{
  e.preventDefault();error.textContent='';const button=form.querySelector('button');button.disabled=true;
  try{const r=await action('start',{account:new FormData(form).get('account')});form.hidden=true;document.querySelector('#device').hidden=false;showCode(r);setTimeout(poll,5000);}
  catch(e){error.textContent=e.message;button.disabled=false;}
});
