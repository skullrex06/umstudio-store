const json = (data, status=200, headers={}) =>
  new Response(JSON.stringify(data), {status, headers: {"content-type":"application/json; charset=utf-8", ...headers}});
const html = (body, status=200) => new Response(body, {status, headers: {"content-type":"text/html; charset=utf-8"}});
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const b64 = b => btoa(String.fromCharCode(...new Uint8Array(b)));
const unhex = s => new Uint8Array(s.match(/.{1,2}/g).map(x=>parseInt(x,16)));
const hex = b => [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
async function sha(s){ return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function passwordHash(password, salt=crypto.getRandomValues(new Uint8Array(16))){
  const key=await crypto.subtle.importKey("raw",enc.encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt,iterations:210000,hash:"SHA-256"},key,256);
  return `${b64(salt)}:${b64(bits)}`;
}
async function verifyPassword(password, stored){
  const [s,h]=stored.split(":");
  const salt=Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  const candidate=await passwordHash(password,salt);
  return candidate===stored;
}
function cookie(req,name){
  const c=req.headers.get("Cookie")||"";
  const item=c.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="));
  return item ? decodeURIComponent(item.slice(name.length+1)) : null;
}
const cookieHeader=(name,value,maxAge,secure=true)=>`${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?"; Secure":""}`;
async function currentUser(req,env){
  const raw=cookie(req,"um_session"); if(!raw) return null;
  const s=await env.DB.prepare("SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?").bind(await sha(raw),Math.floor(Date.now()/1000)).first();
  return s||null;
}
function requireHttpsOrigin(req,env){
  const origin=req.headers.get("Origin");
  if(origin && env.SITE_URL && origin!==env.SITE_URL) throw new Error("Invalid request origin");
}
async function body(req){ return await req.json().catch(()=>({})); }
async function stripeRequest(env,params){
  const form=new URLSearchParams(params);
  const r=await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,"Content-Type":"application/x-www-form-urlencoded"},body:form});
  const data=await r.json(); if(!r.ok) throw new Error(data.error?.message||"Payment provider error"); return data;
}
async function verifyStripeSignature(raw,header,secret){
  const parts=Object.fromEntries(header.split(",").map(x=>x.split("=").map(y=>y.trim())));
  if(!parts.t||!parts.v1) return false;
  const key=await crypto.subtle.importKey("raw",enc.encode(secret),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const sig=await crypto.subtle.sign("HMAC",key,enc.encode(`${parts.t}.${raw}`));
  return hex(sig)===parts.v1;
}
async function api(req,env){
  const url=new URL(req.url), path=url.pathname, method=req.method;
  if(path==="/api/health") return json({ok:true,store:"UMstudio",currency:"usd"});
  if(path==="/api/products" && method==="GET"){
    const rows=await env.DB.prepare("SELECT id,slug,name,description,price_cents,currency,cover_url FROM products WHERE active=1 ORDER BY created_at DESC").all();
    return json(rows.results);
  }
  if(path==="/api/register" && method==="POST"){
    requireHttpsOrigin(req,env); const b=await body(req), email=String(b.email||"").trim().toLowerCase(), pass=String(b.password||"");
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||pass.length<12) return json({error:"Use a valid email and a password of at least 12 characters."},400);
    const id=uid(), hash=await passwordHash(pass);
    try{await env.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)").bind(id,email,hash).run();}
    catch{return json({error:"An account with this email may already exist."},409);}
    return await createSession(id,email,"customer",env);
  }
  if(path==="/api/login" && method==="POST"){
    requireHttpsOrigin(req,env); const b=await body(req), email=String(b.email||"").trim().toLowerCase(), pass=String(b.password||"");
    const u=await env.DB.prepare("SELECT id,email,password_hash,role FROM users WHERE email=?").bind(email).first();
    if(!u || !(await verifyPassword(pass,u.password_hash))) return json({error:"Email or password is incorrect."},401);
    return await createSession(u.id,u.email,u.role,env);
  }
  if(path==="/api/logout" && method==="POST"){
    const raw=cookie(req,"um_session"); if(raw) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha(raw)).run();
    return json({ok:true},200,{"Set-Cookie":cookieHeader("um_session","",0)});
  }
  if(path==="/api/me" && method==="GET"){
    const u=await currentUser(req,env); return json({user:u?{id:u.id,email:u.email,role:u.role}:null});
  }
  if(path==="/api/checkout" && method==="POST"){
    const u=await currentUser(req,env); if(!u) return json({error:"Please sign in before checkout."},401);
    if(!env.STRIPE_SECRET_KEY) return json({error:"Payments are not configured yet."},503);
    const b=await body(req), ids=Array.isArray(b.productIds)?b.productIds.slice(0,20):[];
    if(!ids.length) return json({error:"Your cart is empty."},400);
    const unique=[...new Set(ids)];
    const placeholders=unique.map(()=>"?").join(",");
    const rows=(await env.DB.prepare(`SELECT id,name,price_cents,currency FROM products WHERE active=1 AND id IN (${placeholders})`).bind(...unique).all()).results;
    if(rows.length!==unique.length) return json({error:"One or more products are unavailable."},400);
    const orderId=uid(), subtotal=rows.reduce((s,p)=>s+p.price_cents*ids.filter(x=>x===p.id).length,0);
    await env.DB.prepare("INSERT INTO orders(id,user_id,email,currency,subtotal_cents,status) VALUES(?,?,?,'usd',?,'pending')").bind(orderId,u.id,u.email,subtotal).run();
    for(const p of rows){const qty=ids.filter(x=>x===p.id).length;await env.DB.prepare("INSERT INTO order_items(id,order_id,product_id,product_name,unit_price_cents,quantity) VALUES(?,?,?,?,?,?)").bind(uid(),orderId,p.id,p.name,p.price_cents,qty).run();}
    const params={"mode":"payment","success_url":`${env.SITE_URL}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,"cancel_url":`${env.SITE_URL}/?payment=cancelled`,"customer_email":u.email,"client_reference_id":orderId,"metadata[order_id]":orderId,"payment_method_types[0]":"card"};
    let i=0; for(const p of rows){const qty=ids.filter(x=>x===p.id).length;params[`line_items[${i}][price_data][currency]`]="usd";params[`line_items[${i}][price_data][product_data][name]`]=p.name;params[`line_items[${i}][price_data][unit_amount]`]=String(p.price_cents);params[`line_items[${i}][quantity]`]=String(qty);i++;}
    try{const session=await stripeRequest(env,params);await env.DB.prepare("UPDATE orders SET stripe_session_id=? WHERE id=?").bind(session.id,orderId).run();return json({url:session.url});}
    catch(e){await env.DB.prepare("UPDATE orders SET status='failed' WHERE id=?").bind(orderId).run();return json({error:e.message},502);}
  }
  if(path==="/api/orders" && method==="GET"){
    const u=await currentUser(req,env);if(!u)return json({error:"Sign in required."},401);
    const orders=(await env.DB.prepare("SELECT id,currency,subtotal_cents,status,created_at,paid_at FROM orders WHERE user_id=? ORDER BY created_at DESC").bind(u.id).all()).results;
    return json(orders);
  }
  if(path==="/api/downloads" && method==="GET"){
    const u=await currentUser(req,env);if(!u)return json({error:"Sign in required."},401);
    const rows=(await env.DB.prepare(`SELECT e.id,e.downloads_used,e.max_downloads,p.name,p.id product_id
      FROM download_entitlements e JOIN products p ON p.id=e.product_id WHERE e.user_id=? ORDER BY e.created_at DESC`).bind(u.id).all()).results;
    return json(rows);
  }
  if(path.startsWith("/api/download/") && method==="POST"){
    const u=await currentUser(req,env);if(!u)return json({error:"Sign in required."},401);
    const entitlementId=path.split("/").pop();
    const e=await env.DB.prepare(`SELECT e.id,e.downloads_used,e.max_downloads,p.file_key,p.name
      FROM download_entitlements e JOIN products p ON p.id=e.product_id WHERE e.id=? AND e.user_id=?`).bind(entitlementId,u.id).first();
    if(!e)return json({error:"Download not found."},404);
    if(e.downloads_used>=e.max_downloads)return json({error:"Download limit reached. Contact support."},403);
    const object=await env.FILES.get(e.file_key);if(!object)return json({error:"The digital file is not available. Contact support."},404);
    await env.DB.prepare("UPDATE download_entitlements SET downloads_used=downloads_used+1 WHERE id=?").bind(e.id).run();
    const headers=new Headers();object.writeHttpMetadata(headers);headers.set("Content-Disposition",`attachment; filename="${(e.name||"download").replace(/[^a-z0-9._ -]/gi,"")}.pdf"`);headers.set("Cache-Control","private, no-store");
    return new Response(object.body,{headers});
  }
  if(path==="/api/admin/summary" && method==="GET"){
    const u=await currentUser(req,env);if(!u||u.role!=="admin")return json({error:"Admin access required."},403);
    const [p,o,s]=await Promise.all([
      env.DB.prepare("SELECT COUNT(*) n FROM products").first(),
      env.DB.prepare("SELECT COUNT(*) n FROM orders").first(),
      env.DB.prepare("SELECT COALESCE(SUM(subtotal_cents),0) n FROM orders WHERE status='paid'").first()
    ]);return json({products:p.n,orders:o.n,revenue_usd:(s.n/100).toFixed(2)});
  }
  if(path==="/api/admin/upload" && method==="POST"){
    const u=await currentUser(req,env);if(!u||u.role!=="admin")return json({error:"Admin access required."},403);
    const form=await req.formData(), file=form.get("file");
    if(!file || typeof file==="string" || !file.size)return json({error:"Choose a file to upload."},400);
    if(file.size>25*1024*1024)return json({error:"File exceeds the 25 MB upload limit."},413);
    const safe=String(file.name||"download").replace(/[^a-z0-9._-]/gi,"_");
    const key=`products/${uid()}-${safe}`;
    await env.FILES.put(key,file.stream(),{httpMetadata:{contentType:file.type||"application/octet-stream"}});
    return json({key,size:file.size});
  }
  if(path==="/api/admin/products" && method==="POST"){
    const u=await currentUser(req,env);if(!u||u.role!=="admin")return json({error:"Admin access required."},403);
    const b=await body(req),name=String(b.name||"").trim(),slug=String(b.slug||"").trim().toLowerCase(),description=String(b.description||""),price=Math.round(Number(b.price)*100),fileKey=String(b.file_key||"").trim(),cover=String(b.cover_url||"");
    if(!name||!slug||!Number.isInteger(price)||price<1||!fileKey)return json({error:"Name, slug, positive price and uploaded R2 file key are required."},400);
    try{await env.DB.prepare("INSERT INTO products(id,slug,name,description,price_cents,currency,cover_url,file_key) VALUES(?,?,?, ?,?,'usd',?,?)").bind(uid(),slug,name,description,price,cover,fileKey).run();}
    catch{return json({error:"Product slug already exists."},409);}
    return json({ok:true});
  }
  if(path.startsWith("/api/webhooks/stripe") && method==="POST"){
    const raw=await req.text(), sig=req.headers.get("Stripe-Signature")||"";
    if(!env.STRIPE_WEBHOOK_SECRET||!(await verifyStripeSignature(raw,sig,env.STRIPE_WEBHOOK_SECRET)))return json({error:"Invalid webhook signature."},400);
    const event=JSON.parse(raw);
    if(event.type==="checkout.session.completed"||event.type==="checkout.session.async_payment_succeeded"){
      const s=event.data.object, orderId=s.metadata?.order_id||s.client_reference_id;
      if(orderId && s.payment_status==="paid"){
        await env.DB.prepare("UPDATE orders SET status='paid',stripe_payment_intent=?,paid_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'").bind(s.payment_intent||null,orderId).run();
        const items=(await env.DB.prepare("SELECT oi.id,oi.product_id,o.user_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.order_id=?").bind(orderId).all()).results;
        for(const it of items)await env.DB.prepare("INSERT OR IGNORE INTO download_entitlements(id,order_item_id,user_id,product_id) VALUES(?,?,?,?)").bind(uid(),it.id,it.user_id,it.product_id).run();
      }
    } else if(event.type==="checkout.session.expired"){
      const s=event.data.object,orderId=s.metadata?.order_id||s.client_reference_id;
      if(orderId)await env.DB.prepare("UPDATE orders SET status='failed' WHERE id=? AND status='pending'").bind(orderId).run();
    }
    return json({received:true});
  }
  return json({error:"Not found."},404);
}
async function createSession(id,email,role,env){
  const raw=b64(crypto.getRandomValues(new Uint8Array(32))),ttl=Number(env.SESSION_TTL_SECONDS||2592000);
  await env.DB.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)").bind(await sha(raw),id,Math.floor(Date.now()/1000)+ttl).run();
  return json({user:{id,email,role}},200,{"Set-Cookie":cookieHeader("um_session",raw,ttl)});
}
export default {
 async fetch(req,env){
  const url=new URL(req.url);
  try{
   if(url.pathname.startsWith("/api/"))return await api(req,env);
   if(url.pathname==="/")return env.ASSETS.fetch(req);
   return env.ASSETS.fetch(req);
  }catch(e){return json({error:e.message||"Server error."},500);}
 }
};
