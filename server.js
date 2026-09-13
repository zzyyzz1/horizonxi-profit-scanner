import express from "express";
import * as cheerio from "cheerio";
const app=express(); app.use(express.static("public"));
const BASE="https://www.psxi.gg";
async function getPage(path){
 const r=await fetch(BASE+path,{headers:{"user-agent":"HorizonXI-Profit-Scanner/1.0"}});
 if(!r.ok) throw new Error(`PSXI ${r.status}`);
 return await r.text();
}
function num(s){let m=(s||"").replace(/,/g,"").match(/(\d+)/);return m?+m[1]:null}
app.get("/api/item",async(req,res)=>{
 try{
  let slug=String(req.query.slug||"").replace(/[^a-z0-9-]/gi,"");
  let cat=String(req.query.cat||"").replace(/[^a-z0-9-]/gi,"");
  if(!slug||!cat) return res.status(400).json({error:"cat and slug required"});
  let html=await getPage(`/s/horizonxi/ah/${cat}/${slug}`),$=cheerio.load(html),text=$("body").text().replace(/\s+/g," ");
  let title=$("h1").first().text().trim();
  function block(label,next){let i=text.indexOf(label);if(i<0)return "";let j=next?text.indexOf(next,i+label.length):-1;return text.slice(i,j>i?j:i+350)}
  let single=block("Single","Stack"), stack=block("Stack","Recent Auction House Sales");
  res.json({title,singlePrice:num(single.match(/Single\s*([\d,]+)\s*gil/i)?.[1]),singleStock:num(single.match(/Stock\s*([\d,]+)/i)?.[1]),stackPrice:num(stack.match(/Stack\s*([\d,]+)\s*gil/i)?.[1]),stackStock:num(stack.match(/Stock\s*([\d,]+)/i)?.[1]),source:BASE+`/s/horizonxi/ah/${cat}/${slug}`});
 }catch(e){res.status(500).json({error:e.message})}
});
app.get("/api/health",(q,r)=>r.json({ok:true}));
const port=process.env.PORT||3000; app.listen(port,()=>console.log("HorizonXI scanner:",port));
