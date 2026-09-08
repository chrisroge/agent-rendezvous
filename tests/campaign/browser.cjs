const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '@playwright/test');
const fs=require('fs');
(async()=>{const browser=await chromium.launch({headless:true});const results=[];
for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:18080/',{waitUntil:'networkidle'});await page.screenshot({path:'.stage/home-'+name+'.png',fullPage:true});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);await page.locator('summary').first().click();const expanded=await page.locator('details').first().getAttribute('open');
 await page.getByRole('link',{name:'Join the free waitlist'}).first().click();await page.waitForURL('**/be-found');
 results.push({name,width,overflow,faqExpanded:expanded!==null,waitlistWorks:page.url().endsWith('/be-found'),errors});await page.close();
}await browser.close();fs.writeFileSync('.stage/browser.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));if(results.some(r=>r.overflow||!r.faqExpanded||!r.waitlistWorks||r.errors.length))process.exitCode=1;})();
