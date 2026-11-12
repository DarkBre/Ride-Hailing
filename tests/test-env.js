'use strict';

// Unit/integration tests are development-mode tests. Production secret validation
// is covered separately by payment-config.test.js in a child process.
process.env.NODE_ENV = 'development';
