## QOL

### General

"  Worth fixing: make check can't catch this. To stop it recurring on a fresh Windows checkout, run git add --renormalize . and    
  check it commits nothing unexpected. Setting core.autocrlf to input also helps." with respect to " Cause: the deploy is failing, not stuck. The app crashes on startup with Error: Migrate(VersionMismatch(1)) and the machine     
  restarts in a loop. fly status shows it as stopped, so wla-prod is down right now. The health check just keeps reporting "the   
  machine hasn't started". The error releasing builder: deadline_exceeded line is only builder cleanup and is unrelated.

  Why: sqlx compares each migration's checksum with the one stored in the database, and migration 1 didn't match. The migration   
  files 0001_initial.sql and 0002_assets.sql were checked out on your Windows machine with CRLF line endings. The Dockerfile      
  copies the working tree, so the image shipped the CRLF bytes. Prod had applied the LF version, and the checksums differ.        
  .gitattributes already says migrations should be LF, but those two files predate that rule and were never re-checked-out. Git   
  status hides the difference because it normalises line endings. The committed contents are unchanged.

  Fix, already done locally: I deleted and re-checked-out those two files, and they are now LF with no CRs. git status is clean   
  for them. Migrations 0003–0011 were already LF."

### On comp

### phone

the "🕘 Changes" on mobile can this be a thing on the left hand side like a small tab thing you tap that brings it out? its not something people will want to look at all the time anyway


## Ready to go live:
  When you're ready to be found, the changes would be: 
  1. Remove SiteGate from App.tsx, which is a one-line change.
  2. Give the landing page a proper <title>, meta description and social preview tags. 
  3. Add robots.txt and a sitemap.
  4. Serve the landing page as static HTML, either prerendered or a separate static    
     page. That's the step that lets AI crawlers read it.

 Run make clean-cache whenever the disk gets low, as   
  long as nothing is compiling