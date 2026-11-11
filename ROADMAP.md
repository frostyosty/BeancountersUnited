## QOL

### General

 Real explanations: you do need an API key. Make an account at console.anthropic.com, which is separate from a Claude.ai or Claude Code     
    subscription and billed per use. Then set (as an export command, like "export AI_PROVIDER=fake" straight into bash):
    - AI_PROVIDER=anthropic
    - AI_API_KEY=<your key>
    - optionally AI_MODEL. It defaults to claude-haiku-5-5, which is cheap.
  - Another provider: AI_PROVIDER=openai_compatible also needs AI_PROVIDER_NAME, AI_MODEL and AI_BASE_URL.
  Restart the server after setting these. If AI_PROVIDER is missing, or AI_API_KEY is missing for a real provider, the server silently disables
  AI and shows this message. The check is in crates/ai/src/lib.rs:200.
  Once it's on, limits apply by default: 5 explanations per business, 10 per IP and 50 across everyone. You can change them with the
  ACCT_AI_EXPLAIN_* variables, and ACCT_AI_DAILY_BUDGET_CENTS caps the daily spend.



Up to M23start wave 3 (agents 5 and 6). wave 2 complete

For M25, please make it an intuitive claude "ask the experts" modal where theres also an example one for the 3 ofx examples, where the user sees a button come up when theyre in the 
Save tax section (the button can show under there "ask the experts - 1 question left today" and should appear once there's 3 seconds of inactivity on the screen. or should it be more? 10?) once the ubtton is clicked a modal spawns where they can type and send a question, (wit ha greyed out sample question filled in) and they see buttons under the modal saying "send" "graph please" and "dismiss" and if they click on graph then claude makes a graph for them in the webpage responding to the question, and if theres no question then just general graphs showing income over the years etc or if just one year idk maybe a bar chart showing expenses or something? Would we build an mcp so its easy for claude to do this and light on tokens? would be both for owners/accountants/everyone although I suppose mcp stuff might have tiers? We should already have most of this functionality in place I believe.


When the business owner is ticking boxes and the like while processing "cut taxes", as well as uploading documents and invoices, these steps should all be recorded (and i think nice color coding could be nice here) and show under user changes on the side. perhaps a batch like system "[username] made 18 changes, 3 declaratory, $15,300 tax impact +" and you can click to expand and can drill down into the details (and back up) from there without opening modals etc (max UX) but it still looks nice.

### On comp

### phone


## Ready to go live:
  When you're ready to be found, the changes would be: 
  1. Remove SiteGate from App.tsx, which is a one-line change.
  2. Give the landing page a proper <title>, meta description and social preview tags. 
  3. Add robots.txt and a sitemap.
  4. Serve the landing page as static HTML, either prerendered or a separate static    
     page. That's the step that lets AI crawlers read it.

 Run make clean-cache whenever the disk gets low, as   
  long as nothing is compiling