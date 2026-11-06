## QOL

### General


"Idea Letting visitors see the accountant side before signing up: yes. It shows the main pitch, "your accountant works on the same books, nothing is typed twice". Owners will like it, and accountants can judge the product in one click. In M21 the three "boring stuff, for accountants" tiles become buttons. If no trial is loaded, a tile loads Example 1 and opens that screen, read-only.

Signing up at the peak: yes, with firm rules. There's no prompt on arrival and none when they leave. M21 asks only at these moments:
- the first time Save tax saves $100 or more on their own file ("Keep the $X you've saved");
- at Submit, because filing needs an account;
- when they try something that needs one, like inviting their accountant or downloading the PDF.

For an example, the peak moment says "drop your own statement", not "sign up", because examples can't be saved. Each sign-up records which moment led to it, so you can see what works without any tracking tools.

Should clicking the accountant tiles prompt an accountant sign-up? Offer it, but don't assume it. Owners will click those tiles too.
- An accountant who gets sent down the owner path loses one click.
- An owner sent down the accountant path loses their trial.

So a guest who opened the accountant view is asked "Who are you?" before saving, with "I run this business" already selected.

There's a catch: accountants can't sign themselves up today. The server has one practice, and an admin creates every practice user. So in M21 the accountant choice sends a "get a practice account" request that someone follows up by hand. Self-serve accountant accounts need each practice to have its own separate data first. That's the white-label item in the backlog, and it's a milestone of its own.

M21 has five agents in four waves. Wave 1 writes ADR 015, which leaves you one decision: whether accepting a practice request should create that accountant's account automatically." please make M22 with this in mind (see how much M21 covered first)

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