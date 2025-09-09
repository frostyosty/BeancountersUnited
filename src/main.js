// src/main.js - MINIMAL IMPORT TEST

console.log("--- main.js: SCRIPT STARTED ---");

// We are only importing ONE file to see if it crashes.
// We start with the one we are most suspicious of.
import * as uiUtils from './utils/uiUtils.js';

console.log("--- main.js: SCRIPT FINISHED ---");
console.log("uiUtils module content:", uiUtils); // Let's see what was imported

// No other code. No functions, no app initialization. Just the import.