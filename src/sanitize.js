/**
 * sanitize.js - Repository text on its way to a terminal
 *
 * A directory name, a pipeline filter value or a question quoting one comes from
 * the audited repository. Anything that prints it to a terminal goes through
 * here, so there is one definition of "safe to print" rather than one per file.
 */

'use strict';

/**
 * Stripped of anything a terminal would act on: ANSI escape sequences first (so
 * their printable tail does not survive), then every remaining control
 * character, which also removes a newline that could forge a line.
 */
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

function printable(text) {
  return String(text).replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARS, '');
}

module.exports = { printable };
