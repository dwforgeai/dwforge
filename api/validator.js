// DWForge Output Validator — Sprint 6
// Validates generated Mule project files before delivery to user

export function validateProject(files) {
  const errors = [];
  const warnings = [];

  for (const [path, content] of Object.entries(files)) {
    if (!content || content.trim().length === 0) {
      errors.push(`${path}: empty file`);
      continue;
    }

    if (path.endsWith('.xml')) {
      const result = validateXml(path, content);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    if (path === 'pom.xml') {
      const result = validatePom(content);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    if (path.endsWith('application.yaml') || path.endsWith('application.yml')) {
      const result = validateProperties(content);
      warnings.push(...result.warnings);
    }
  }

  const requiredFiles = [
    'pom.xml',
    'src/main/resources/application.yaml',
  ];

  for (const req of requiredFiles) {
    const found = Object.keys(files).some(p => p.endsWith(req) || p === req);
    if (!found) warnings.push(`Missing recommended file: ${req}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateXml(path, content) {
  const errors = [];
  const warnings = [];
  const c = content.trim();

  if (!c.startsWith('<?xml')) {
    errors.push(`${path}: missing XML declaration`);
  }

  const openTags = (c.match(/<[a-zA-Z][^/!?][^>]*[^/]>/g) || []).length;
  const closeTags = (c.match(/<\/[a-zA-Z][^>]*>/g) || []).length;
  const selfClose = (c.match(/<[^>]+\/>/g) || []).length;

  if (Math.abs(openTags - closeTags) > 5) {
    errors.push(`${path}: likely unclosed XML tags (${openTags} open, ${closeTags} close)`);
  }

  if (path.includes('main') || path.includes('flow') || path.includes('common')) {
    if (!c.includes('xmlns="http://www.mulesoft.org/schema/mule/core"')) {
      errors.push(`${path}: missing core Mule namespace`);
    }
    if (!c.includes('xsi:schemaLocation')) {
      warnings.push(`${path}: missing xsi:schemaLocation`);
    }
    if (c.includes('<flow') && !c.includes('doc:name')) {
      warnings.push(`${path}: flow elements missing doc:name attribute`);
    }
    if (!c.includes('logger') && !c.includes('<ee:transform')) {
      warnings.push(`${path}: no logger or transform found in flow`);
    }
    if (c.includes('hardcoded') || c.includes('YOUR_') || c.includes('TODO')) {
      errors.push(`${path}: contains placeholder text`);
    }
    const credentialPatterns = [/password\s*=\s*"[^${}][^"]{3,}"/, /token\s*=\s*"[^${}][^"]{3,}"/];
    for (const pat of credentialPatterns) {
      if (pat.test(c)) {
        errors.push(`${path}: possible hardcoded credential detected — use \${property.name}`);
      }
    }
  }

  if (path.includes('error') || path.includes('error-handler')) {
    if (!c.includes('on-error-continue') && !c.includes('on-error-propagate')) {
      warnings.push(`${path}: error handler file has no on-error-continue or on-error-propagate`);
    }
  }

  if (path.includes('munit') || path.includes('test')) {
    if (!c.includes('munit:test')) {
      warnings.push(`${path}: MUnit file has no test cases`);
    }
    if (!c.includes('munit-tools:mock-when') && !c.includes('mock')) {
      warnings.push(`${path}: MUnit tests have no mocks — connector calls may fail in test`);
    }
  }

  return { errors, warnings };
}

function validatePom(content) {
  const errors = [];
  const warnings = [];
  const c = content;

  if (!c.includes('<modelVersion>4.0.0</modelVersion>')) {
    errors.push('pom.xml: missing or incorrect modelVersion');
  }
  if (!c.includes('mule-maven-plugin')) {
    errors.push('pom.xml: missing mule-maven-plugin');
  }
  if (!c.includes('<packaging>mule-application</packaging>')) {
    errors.push('pom.xml: missing mule-application packaging');
  }
  if (c.includes('1.0-SNAPSHOT') || c.includes('SNAPSHOT')) {
    warnings.push('pom.xml: version is SNAPSHOT — change before production deploy');
  }

  const badVersions = [
    { artifact: 'mule-salesforce-connector', bad: ['10.18', '10.19', '10.20'], good: '10.21.0' },
    { artifact: 'mule-http-connector', bad: ['1.7', '1.8'], good: '1.9.4' },
  ];

  for (const check of badVersions) {
    for (const badVer of check.bad) {
      if (c.includes(check.artifact) && c.includes(badVer)) {
        warnings.push(`pom.xml: ${check.artifact} version may be outdated — recommend ${check.good}`);
      }
    }
  }

  return { errors, warnings };
}

function validateProperties(content) {
  const warnings = [];
  const c = content;

  const hardcodedPatterns = [
    /password:\s*[^$\n]{6,}/,
    /clientSecret:\s*[^$\n]{6,}/,
    /apiKey:\s*[^$\n]{6,}/,
  ];

  for (const pat of hardcodedPatterns) {
    if (pat.test(c)) {
      warnings.push('application.yaml: possible hardcoded credential — use ${ENV_VAR} references');
      break;
    }
  }

  return { warnings };
}

export function formatValidationReport(result) {
  if (result.valid && result.warnings.length === 0) {
    return { status: 'clean', message: 'All files validated. Ready to import.' };
  }
  if (result.valid) {
    return {
      status: 'warnings',
      message: `Project valid with ${result.warnings.length} warning(s). Review before deploying.`,
      warnings: result.warnings,
    };
  }
  return {
    status: 'errors',
    message: `${result.errors.length} error(s) found. Fix before importing into Anypoint Studio.`,
    errors: result.errors,
    warnings: result.warnings,
  };
}
