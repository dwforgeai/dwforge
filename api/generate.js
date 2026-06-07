import { readFileSync } from 'fs';
import { join } from 'path';

// ─── KNOWLEDGE CORPUS (Sprint 1: RAG patterns) ──────────────────────────────

const PATTERNS = {
  'salesforce-netsuite': {
    criticalRules: [
      'entity.id must be netsuite_customer_id__c (NetSuite internal ID), never Salesforce AccountId',
      'item.item.id must be netsuite_item_id__c. If null on any line route to dead letter queue',
      'externalId must always be Opportunity.Id — prevents duplicate SalesOrders on retry',
      'tranDate format is M/d/yyyy (no leading zeros). NetSuite rejects ISO 8601',
      'currency.refName is full English name: USD → US Dollar, AUD → Australian Dollar',
      'OpportunityLineItems.records can be null — always default to empty array []',
      'NetSuite item structure is item.items[]{item:{id}, quantity, rate, amount} — nested',
    ],
    keyMappings: 'entity.id←Account.netsuite_customer_id__c | tranDate←CloseDate(M/d/yyyy) | memo←Name | externalId←Id | item.items[]←OpportunityLineItems',
    dateFunction: "fun toNSDate(d) = if (d!=null and d!='') (d as Date{format:'yyyy-MM-dd'}) as String{format:'M/d/yyyy'} else null",
    currencyMap: 'USD→"US Dollar" | AUD→"Australian Dollar" | GBP→"British Pound" | EUR→"Euro"',
    connectors: ['http-connector'],
    endpoint: 'POST /services/rest/record/v1/salesOrder',
  },
  'salesforce-sap': {
    criticalRules: [
      'SAP material numbers must be left-padded to 18 chars: "100" → "000000000000000100"',
      'SAP customer numbers (KUNNR) left-padded to 10 chars',
      'SAP dates are YYYYMMDD format — no hyphens',
      'Empty strings in SAP BAPI cause RFC_ERROR — use null not empty string for optional fields',
      'Sales org, distribution channel, division must all be populated — come from config not payload',
      'ORDER_ITEMS_IN[].TARGET_QTY as string with 3 decimals: "5.000"',
    ],
    keyMappings: 'KUNNR←Account.SAP_Customer_Number__c padded-10 | MATERIAL←Product2.SAP_Material_Number__c padded-18 | PURCH_NO_C←Opportunity.Name | date→YYYYMMDD',
    paddingFunctions: "fun padMaterial(m) = ('000000000000000000'++m)[-18 to -1]\nfun padCustomer(c) = ('0000000000'++c)[-10 to -1]",
    dateFunction: "fun toSAPDate(d) = if (d!=null and d!='') (d as Date{format:'yyyy-MM-dd'}) as String{format:'yyyyMMdd'} else null",
    connectors: ['sap-connector', 'http-connector'],
    endpoint: 'BAPI_SALESORDER_CREATEFROMDAT2 or OData /API_SALES_ORDER_SRV',
  },
  'workday-salesforce': {
    criticalRules: [
      'Workday REST responses wrap records in data array: payload.data map (w) → ...',
      'Always set Worker_ID__c as external ID for Salesforce upsert',
      'Workday dates come as ISO 8601 with timezone — strip time for Salesforce Date fields',
      'Extract primary position only: worker.positions[0]? — array can be empty for terminated',
      'email_addresses can be empty array — use [0]? not [0]',
      'Terminated workers: Employment_Status = "Terminated" → IsActive = false',
    ],
    keyMappings: 'FirstName←name.First_Name | LastName←name.Last_Name | Email←email_addresses[0]?.Email_Address | Worker_ID__c←Worker_ID(externalId) | IsActive←status!="Terminated"',
    dateFunction: "fun stripTime(d) = if (d!=null and d!='') d[0 to 9] else null",
    connectors: ['workday-connector', 'salesforce-connector', 'http-connector'],
    salesforceOperation: 'UPSERT on Worker_ID__c',
  },
  'salesforce-d365': {
    criticalRules: [
      'dataAreaId required on every entity — never null, matches legal entity (e.g. USMF)',
      'D365 dates must include time: CloseDate + "T00:00:00Z"',
      'CustomerAccount must exist before SalesOrder — sync sequence matters',
      'String max lengths enforced: CustomerAccount 20 chars, Name 60 chars',
      'D365 token lifetime 1 hour — implement token caching in Mule',
      'PATCH must not include @odata.etag on POST for new records',
    ],
    keyMappings: 'dataAreaId←config/properties | CustomerAccount←Account.ERP_Account_Number__c | SalesOrderName←Opportunity.Name | CurrencyCode←CurrencyIsoCode | RequestedShipDate←CloseDate+"T00:00:00Z"',
    dateFunction: "fun toD365Date(d) = if (d!=null and d!='') d++'T00:00:00Z' else null",
    auth: 'OAuth 2.0 Client Credentials via Azure AD tenant',
    connectors: ['http-connector', 'salesforce-connector'],
  },
  'd365-salesforce': {
    criticalRules: [
      'Follow @odata.nextLink pagination — never stop at first page',
      'D365 datetime → Salesforce date: strip time portion d[0 to 9]',
      'D365 SalesStatus comes as integer (1=Draft, 2=Confirmed, 3=Invoiced, 4=Cancelled)',
      'Delta token expires after 7 days — fall back to full sync with date filter',
      '@removed records in delta = soft delete — set IsDeleted or status in Salesforce',
    ],
    keyMappings: 'ERP_Account_Number__c←CustomerAccount(externalId) | Name←CustomerName | SalesStatus:{1:"Draft",2:"Confirmed",3:"Invoiced",4:"Cancelled"}',
    dateFunction: "fun fromD365Date(d) = if (d!=null and d!='') d[0 to 9] else null",
    connectors: ['http-connector', 'salesforce-connector'],
    salesforceOperation: 'UPSERT via composite API, 200 records per batch',
  },
  'workday-d365': {
    criticalRules: [
      'Map Workday position to D365 HcmWorker entity',
      'Workday employee ID → D365 PersonnelNumber',
      'D365 requires LegalEntityId (e.g. USMF) on every worker record',
      'Workday cost centre maps to D365 Financial Dimension — lookup required',
    ],
    keyMappings: 'PersonnelNumber←Worker_ID | LegalEntityId←from config | FirstName←name.First_Name | LastName←name.Last_Name',
    connectors: ['workday-connector', 'http-connector'],
  },
  'sap-salesforce': {
    criticalRules: [
      'SAP IDOC or OData inbound — parse RFC structure carefully',
      'SAP customer KUNNR needs leading zeros stripped for Salesforce readability',
      'SAP material numbers — strip leading zeros for human-readable product names',
      'SAP dates YYYYMMDD → Salesforce date yyyy-MM-dd',
    ],
    keyMappings: 'ERP_Customer__c←KUNNR | Name←NAME1 | Currency__c←WAERK | Amount__c←NETWR as Number',
    dateFunction: "fun fromSAPDate(d) = if (d!=null and d!='') (d as Date{format:'yyyyMMdd'}) as String{format:'yyyy-MM-dd'} else null",
    connectors: ['sap-connector', 'salesforce-connector', 'http-connector'],
  },
};

// ─── SPRINT 6: OUTPUT VALIDATOR ──────────────────────────────────────────────

function validateProject(files) {
  const errors = [], warnings = [];
  for (const [path, content] of Object.entries(files)) {
    if (!content || !content.trim()) { errors.push(`${path}: empty file`); continue; }
    if (path.endsWith('.xml')) {
      const c = content;
      if (!c.startsWith('<?xml')) errors.push(`${path}: missing XML declaration`);
      if ((path.includes('main') || path.includes('flow') || path.includes('common')) && !c.includes('xmlns="http://www.mulesoft.org/schema/mule/core"')) errors.push(`${path}: missing core Mule namespace`);
      if (c.includes('YOUR_') || c.includes('TODO') || c.includes('PLACEHOLDER')) errors.push(`${path}: contains placeholder text`);
      if (/password\s*=\s*"[^${}][^"]{3,}"/.test(c)) errors.push(`${path}: possible hardcoded credential — use \\${property.name}`);
    }
    if (path === 'pom.xml') {
      if (!content.includes('mule-maven-plugin')) errors.push('pom.xml: missing mule-maven-plugin');
      if (!content.includes('<packaging>mule-application</packaging>')) errors.push('pom.xml: missing mule-application packaging');
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

function formatValidationReport(result) {
  if (result.valid && result.warnings.length === 0) return { status: 'clean', message: 'All files validated. Ready to import into Anypoint Studio.' };
  if (result.valid) return { status: 'warnings', message: `Valid with ${result.warnings.length} warning(s).`, warnings: result.warnings };
  return { status: 'errors', message: `${result.errors.length} error(s) found. Review before importing.`, errors: result.errors, warnings: result.warnings };
}



function detectSystems(source, target) {
  const clean = (s) => (s || '').toLowerCase()
    .replace(/microsoft\s*/g, '')
    .replace(/d365\s*f&o/g, 'd365')
    .replace(/d365\s*fo/g, 'd365')
    .replace(/dynamics\s*365/g, 'd365')
    .replace(/s\/4hana/g, 'sap')
    .replace(/s4hana/g, 'sap')
    .replace(/sap\s*ecc/g, 'sap')
    .replace(/\s+/g, '');

  const src = clean(source);
  const tgt = clean(target);

  const normalize = (s) => {
    if (s.includes('salesforce') || s.includes('sfdc')) return 'salesforce';
    if (s.includes('netsuite')) return 'netsuite';
    if (s.includes('sap')) return 'sap';
    if (s.includes('workday')) return 'workday';
    if (s.includes('d365') || s.includes('dynamics')) return 'd365';
    if (s.includes('oracle')) return 'oracle';
    if (s.includes('servicenow')) return 'servicenow';
    if (s.includes('hubspot')) return 'hubspot';
    return s;
  };

  return { src: normalize(src), tgt: normalize(tgt) };
}

function retrievePattern(source, target) {
  const { src, tgt } = detectSystems(source, target);
  const key = `${src}-${tgt}`;
  return PATTERNS[key] || null;
}

function buildPatternContext(pattern) {
  if (!pattern) return '';
  const lines = [
    '--- RETRIEVED PRODUCTION PATTERN ---',
    `Critical rules:\n${pattern.criticalRules.map(r => `- ${r}`).join('\n')}`,
    `Key field mappings: ${pattern.keyMappings}`,
    pattern.dateFunction ? `Date conversion: ${pattern.dateFunction}` : '',
    pattern.paddingFunctions ? `Padding: ${pattern.paddingFunctions}` : '',
    pattern.currencyMap ? `Currency map: ${pattern.currencyMap}` : '',
    pattern.connectors ? `Connectors: ${pattern.connectors.join(', ')}` : '',
    pattern.endpoint ? `API endpoint: ${pattern.endpoint}` : '',
    '--- END PATTERN ---',
  ].filter(Boolean);
  return lines.join('\n');
}

// ─── CONNECTOR VERSIONS (Mule 4.6 CloudHub 2.0) ─────────────────────────────

const CONNECTOR_VERSIONS = {
  'http': { groupId: 'org.mule.connectors', artifactId: 'mule-http-connector', version: '1.9.4' },
  'salesforce': { groupId: 'com.mulesoft.connectors', artifactId: 'mule-salesforce-connector', version: '10.21.0' },
  'sap': { groupId: 'com.mulesoft.connectors', artifactId: 'mule-sap-connector', version: '5.13.1' },
  'workday': { groupId: 'com.mulesoft.connectors', artifactId: 'mule-workday-connector', version: '3.3.0' },
  'db': { groupId: 'org.mule.connectors', artifactId: 'mule-db-connector', version: '1.14.1' },
  'netsuite': { groupId: 'com.mulesoft.connectors', artifactId: 'mule-netsuite-connector', version: '11.10.0' },
  'mq': { groupId: 'com.mulesoft.connectors', artifactId: 'mule-anypoint-mq-connector', version: '4.0.10' },
  'file': { groupId: 'org.mule.connectors', artifactId: 'mule-file-connector', version: '1.5.2' },
};

function getConnectorDeps(sourceSystem, targetSystem, patternType) {
  const deps = new Set(['http']);
  const { src, tgt } = detectSystems(sourceSystem, targetSystem);
  if (src === 'salesforce' || tgt === 'salesforce') deps.add('salesforce');
  if (src === 'sap' || tgt === 'sap') deps.add('sap');
  if (src === 'workday' || tgt === 'workday') deps.add('workday');
  if (src === 'netsuite' || tgt === 'netsuite') deps.add('netsuite');
  if (patternType === 'async') deps.add('mq');
  if (patternType === 'file' || patternType === 'batch') deps.add('file');
  return [...deps].map(k => CONNECTOR_VERSIONS[k]).filter(Boolean);
}

// ─── SYSTEM PROMPTS ──────────────────────────────────────────────────────────

const DATAWEAVE_SYSTEM_PROMPT = `You are a senior MuleSoft integration architect generating production DataWeave 2.0 code.

STRICT SYNTAX RULES — every rule is mandatory:

RULE 1: Always start with exactly these three lines, nothing before them:
%dw 2.0
output application/json
---

RULE 2: SINGLE record transformation — access payload fields directly:
%dw 2.0
output application/json
---
{
  targetField: payload.sourceField default ""
}

RULE 3: BATCH transformation — use map on the array:
%dw 2.0
output application/json
---
payload map (item) -> {
  targetField: item.sourceField default ""
}

RULE 4: FILTER + MAP — NEVER chain directly. Always use var:
WRONG: payload filter (...) map (...) -> { }
CORRECT:
%dw 2.0
output application/json
var validRecords = payload filter (item) -> (item.id != null)
---
validRecords map (item) -> {
  targetField: item.sourceField default ""
}

RULE 5: NULL HANDLING — always use default keyword:
field: payload.sourceField default ""
field: payload.sourceField default 0
field: payload.sourceField default false

RULE 6: DATE TO ISO 8601 — always cast to String first:
StartDate: if (payload.StartDate__c != null) (payload.StartDate__c as String) ++ "T00:00:00Z" else null

RULE 7: SALESFORCE RELATIONSHIPS — use safe navigation:
CustomerAccount: payload.Account__r.ERP_ID__c default ""

RULE 8: OUTPUT pure DataWeave ONLY — zero backticks, zero markdown, zero code fences.
The very first character of your response must be % from %dw 2.0.

RULE 9: Code must compile and run in MuleSoft DataWeave Playground without modification.

After the complete DataWeave code, write exactly "EXPLANATION:" on a new line.
Then write 2-3 plain English sentences: what the transformation does, key decisions made, and one thing to verify before deploying.`;

const MULE_PROJECT_SYSTEM_PROMPT = `You are a senior MuleSoft architect following enterprise delivery standards.
Generate ONLY the main flow XML. Global configs, error subflows, and DWL files are injected separately.

Use ONLY this format:

===PROJECT: {appname}-integration===
===FILE: src/main/mule/{appname}-main.xml===
[complete XML here]
===END===

ENTERPRISE STANDARDS — every main flow XML must include:

1. Set these variables at flow entry before any logic:
   <set-variable variableName="transactionId" value="#[correlationId]"/>
   <set-variable variableName="appName" value="#[p('api.name')]"/>
   <set-variable variableName="step" value="entry"/>
   <set-variable variableName="previousError" value="#[null]"/>

2. Update vars.step at each stage: validate-request, transform-request, call-target, transform-response

3. Reference global configs by name — do NOT redefine in main XML:
   config-ref="{appname}-http-listener-config"
   config-ref="{appname}-target-request-config"

4. HTTP Listener response must use vars.httpStatus:
   <http:response statusCode="#[vars.httpStatus default 200]"/>
   <http:error-response statusCode="#[vars.httpStatus default 500]"/>

5. Error handler on every flow calling reusable subflows:
   <on-error-continue type="CONNECTIVITY,TIMEOUT">
     <flow-ref name="common-map-technical-error-subflow"/>
     <set-variable variableName="httpStatus" value="503"/>
     <async><flow-ref name="common-log-error-subflow"/></async>
   </on-error-continue>
   <on-error-continue type="ANY">
     <flow-ref name="common-map-technical-error-subflow"/>
     <set-variable variableName="httpStatus" value="500"/>
     <async><flow-ref name="common-log-error-subflow"/></async>
   </on-error-continue>

6. Include a GET /health flow returning {"status":"UP","app":"#[p('api.name')]"}

Replace {appname} with the actual app name. No markdown. No backticks.\`

// ─── HANDLER ─────────────────────────────────────────────────────────────────

export default async function handler(req, res) {

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-secret');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const clientToken = req.headers['x-api-secret'];
  if (!clientToken || clientToken !== process.env.API_SECRET_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Service configuration error. Please try again later.' });
  }

  try {
    const { mode, prompt, appName, sourceSystem, targetSystem, patternType, apiSpec, volume } = req.body;

    // ── MODE: MULE PROJECT FACTORY (Sprint 5) ─────────────────────────────

    if (mode === 'mule-project') {
      if (!appName || !sourceSystem || !targetSystem) {
        return res.status(400).json({ error: 'App name, source system and target system are required.' });
      }

      const cleanAppName = (appName || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const pattern = retrievePattern(sourceSystem, targetSystem);
      const patternContext = buildPatternContext(pattern);
      const connectorDeps = getConnectorDeps(sourceSystem, targetSystem, patternType);

      const connectorDepsXml = connectorDeps.map(d =>
        `    <dependency>\\n      <groupId>${d.groupId}</groupId>\\n      <artifactId>${d.artifactId}</artifactId>\\n      <version>${d.version}</version>\\n      <classifier>mule-plugin</classifier>\\n    </dependency>`
      ).join('\\n');

      const userPrompt = [
        `Generate a complete Mule 4.6 CloudHub 2.0 project with these specifications:`,
        `App name: ${cleanAppName}`,
        `Source system: ${sourceSystem}`,
        `Target system: ${targetSystem}`,
        `Integration pattern: ${patternType || 'realtime'} API`,
        volume ? `Expected volume: ${volume}` : '',
        apiSpec ? `API specification:\n${apiSpec.substring(0, 3000)}` : '',
        patternContext,
        `Required connector Maven dependencies:\n${connectorDeps.map(d => `${d.groupId}:${d.artifactId}:${d.version}`).join('\n')}`,
      ].filter(Boolean).join('\n\n');

      const response = await callClaude(MULE_PROJECT_SYSTEM_PROMPT, userPrompt, 3000);
      if (!response.ok) return handleClaudeError(response, res);

      const data = await response.json();
      const rawText = (data.content || []).map(b => b.text || '').join('');

      let projectData;
      try {
        const projectMatch = rawText.match(/===PROJECT:\s*([^\n=]+)===/);
        const projectName = projectMatch ? projectMatch[1].trim() : cleanAppName + '-integration';

        const files = {};
        const parts = rawText.split(/===FILE:\s*/);
        for (let i = 1; i < parts.length; i++) {
          const nl = parts[i].indexOf('\n');
          if (nl === -1) continue;
          const filePath = parts[i].substring(0, nl).replace(/=+.*$/, '').trim();
          let content = parts[i].substring(nl + 1).replace(/\n?===END===.*$/s, '').trim();
          if (filePath && content) files[filePath] = content;
        }

        if (Object.keys(files).length === 0) {
          console.error('No files parsed. Raw response start:', rawText.substring(0, 600));
          return res.status(500).json({ error: 'Project generation failed. Please try again.', debug: rawText.substring(0, 300) });
        }

        projectData = { projectName, files };

        // ── ENTERPRISE STATIC FILES ──────────────────────────────────────────
        const connDeps = connectorDeps.map(d =>
          `    <dependency>\n      <groupId>${d.groupId}</groupId>\n      <artifactId>${d.artifactId}</artifactId>\n      <version>${d.version}</version>\n      <classifier>mule-plugin</classifier>\n    </dependency>`
        ).join('\n');

        files['mule-artifact.json'] = `{
  "minMuleVersion": "4.6.0",
  "secureProperties": [
    "secure.key",
    "anypoint.platform.client_id",
    "anypoint.platform.client_secret"
  ]
}`;

        files['src/main/mule/common-error-handler.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core"
      xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="
        http://www.mulesoft.org/schema/mule/core http://www.mulesoft.org/schema/mule/core/current/mule.xsd
        http://www.mulesoft.org/schema/mule/ee/core http://www.mulesoft.org/schema/mule/ee/core/current/mule-ee.xsd">

    <!-- Maps a technical error (connectivity, system failure) to standard response format -->
    <sub-flow name="common-map-technical-error-subflow" doc:name="Map Technical Error">
        <ee:transform doc:name="set-technical-error-payload">
            <ee:message>
                <ee:set-payload resource="dw/set-technical-error-payload.dwl"/>
            </ee:message>
            <ee:variables>
                <ee:set-variable variableName="previousError"><![CDATA[%dw 2.0 output application/java --- payload]]></ee:set-variable>
            </ee:variables>
        </ee:transform>
    </sub-flow>

    <!-- Maps a functional error (bad request, business validation) to standard response format -->
    <sub-flow name="common-map-functional-error-subflow" doc:name="Map Functional Error">
        <ee:transform doc:name="set-functional-error-payload">
            <ee:message>
                <ee:set-payload resource="dw/set-functional-error-payload.dwl"/>
            </ee:message>
            <ee:variables>
                <ee:set-variable variableName="previousError"><![CDATA[%dw 2.0 output application/java --- payload]]></ee:set-variable>
            </ee:variables>
        </ee:transform>
    </sub-flow>

    <!-- Logs error asynchronously — call inside <async> to never delay response -->
    <sub-flow name="common-log-error-subflow" doc:name="Log Error">
        <ee:transform doc:name="build-error-log-payload">
            <ee:message>
                <ee:set-payload><![CDATA[%dw 2.0
output application/json
---
{
    (transactionId: vars.transactionId)   if (vars.transactionId?),
    level:       "ERROR",
    serviceName: vars.appName default "",
    (step:       vars.step)               if (vars.step?),
    status:      "ERROR",
    timestamp:   now() as String {format: "yyyy-MM-dd'T'HH:mm:ss"},
    error: {
        (code:    vars.httpStatus as String) if (vars.httpStatus?),
        type:     error.errorType.identifier default "UNKNOWN",
        message:  error.description default "No description"
    },
    payload: payload
}]]></ee:set-payload>
            </ee:message>
        </ee:transform>
        <logger level="ERROR"
            message="#[output application/json --- payload]"
            doc:name="log-error"/>
    </sub-flow>

</mule>`;

        files['src/main/mule/global.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<mule xmlns="http://www.mulesoft.org/schema/mule/core"
      xmlns:http="http://www.mulesoft.org/schema/mule/http"
      xmlns:ee="http://www.mulesoft.org/schema/mule/ee/core"
      xmlns:os="http://www.mulesoft.org/schema/mule/os"
      xmlns:secure-properties="http://www.mulesoft.org/schema/mule/secure-properties"
      xmlns:doc="http://www.mulesoft.org/schema/mule/documentation"
      xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
      xsi:schemaLocation="
        http://www.mulesoft.org/schema/mule/core http://www.mulesoft.org/schema/mule/core/current/mule.xsd
        http://www.mulesoft.org/schema/mule/http http://www.mulesoft.org/schema/mule/http/current/mule-http.xsd
        http://www.mulesoft.org/schema/mule/ee/core http://www.mulesoft.org/schema/mule/ee/core/current/mule-ee.xsd
        http://www.mulesoft.org/schema/mule/os http://www.mulesoft.org/schema/mule/os/current/mule-os.xsd
        http://www.mulesoft.org/schema/mule/secure-properties http://www.mulesoft.org/schema/mule/secure-properties/current/mule-secure-properties.xsd">

    <!-- Environment and properties -->
    <global-property name="mule.env" value="dev" doc:name="Default environment"/>
    <configuration-properties file="config/config-\${mule.env}.yaml" doc:name="Environment config"/>

    <secure-properties:config name="Secure_Properties_Config"
        file="config/config-\${mule.env}.yaml"
        key="\${secure.key}"
        doc:name="Secure Properties Config">
        <secure-properties:encrypt algorithm="Blowfish"/>
    </secure-properties:config>

    <!-- HTTP Listener -->
    <http:listener-config name="${cleanAppName}-http-listener-config" doc:name="HTTP Listener Config">
        <http:listener-connection host="0.0.0.0" port="\${http.port}"/>
    </http:listener-config>

    <!-- Target system HTTP Request config -->
    <http:request-config name="${cleanAppName}-target-request-config"
        doc:name="Target System HTTP Request Config"
        responseTimeout="\${connections.response.timeout}">
        <http:request-connection
            host="\${target.host}"
            port="\${target.port}"
            protocol="\${target.protocol}">
            <reconnection>
                <reconnect frequency="\${connections.reconn.frequency}" count="\${connections.reconn.attempts}"/>
            </reconnection>
        </http:request-connection>
    </http:request-config>

    <!-- Token caching object store -->
    <os:object-store name="${cleanAppName}-token-store"
        doc:name="Token Object Store"
        maxEntries="1"
        entryTtl="\${token.store.ttl}"
        entryTtlUnit="MINUTES"
        persistent="false"/>

</mule>`;

        files['src/main/resources/config/config-dev.yaml'] = `## Application properties — DEV environment
api:
  name: "${cleanAppName}"
  version: "v1"
  path: "/api/${cleanAppName}/v1/*"

http:
  port: "8081"

## Target system connection
target:
  host: "${cleanAppName}-target.dev.example.com"
  port: "443"
  protocol: "HTTPS"

## Connection pool settings
connections:
  response.timeout: "60000"
  reconn.frequency: "2000"
  reconn.attempts: "2"

## Token store (minutes)
token:
  store.ttl: "55"

## Secure key — set in CloudHub properties, never commit real value
secure:
  key: "changeMe-dev"
`;

        files['src/main/resources/config/config-prod.yaml'] = `## Application properties — PROD environment
api:
  name: "${cleanAppName}"
  version: "v1"
  path: "/api/${cleanAppName}/v1/*"

http:
  port: "8081"

## Target system connection
target:
  host: "${cleanAppName}-target.prod.example.com"
  port: "443"
  protocol: "HTTPS"

## Connection pool settings
connections:
  response.timeout: "60000"
  reconn.frequency: "2000"
  reconn.attempts: "2"

## Token store (minutes)
token:
  store.ttl: "55"

## Secure key — set in CloudHub properties, never commit real value
secure:
  key: "changeMe-dev"
`;

        files['src/main/resources/config/config-sit.yaml'] = `## Application properties — SIT environment
api:
  name: "${cleanAppName}"
  version: "v1"
  path: "/api/${cleanAppName}/v1/*"

http:
  port: "8081"

## Target system connection
target:
  host: "${cleanAppName}-target.sit.example.com"
  port: "443"
  protocol: "HTTPS"

## Connection pool settings
connections:
  response.timeout: "60000"
  reconn.frequency: "2000"
  reconn.attempts: "2"

## Token store (minutes)
token:
  store.ttl: "55"

## Secure key — set in CloudHub properties, never commit real value
secure:
  key: "changeMe-dev"
`;

        files['src/main/resources/config/config-uat.yaml'] = `## Application properties — UAT environment
api:
  name: "${cleanAppName}"
  version: "v1"
  path: "/api/${cleanAppName}/v1/*"

http:
  port: "8081"

## Target system connection
target:
  host: "${cleanAppName}-target.uat.example.com"
  port: "443"
  protocol: "HTTPS"

## Connection pool settings
connections:
  response.timeout: "60000"
  reconn.frequency: "2000"
  reconn.attempts: "2"

## Token store (minutes)
token:
  store.ttl: "55"

## Secure key — set in CloudHub properties, never commit real value
secure:
  key: "changeMe-dev"
`;

        files['src/main/resources/dw/http-status.dwl'] = `%dw 2.0
output application/java
var reason = payload.errors[0].reason default ""
---
if (payload."type" == "Functional")         422
else if (contains(reason, "CONNECTIVITY")
      or contains(reason, "TIMEOUT")
      or contains(reason, "SERVICE_UNAVAILABLE")
      or contains(reason, "RETRY_EXHAUSTED"))  503
else if (contains(reason, "FORBIDDEN"))        403
else if (contains(reason, "UNAUTHORIZED")
      or contains(reason, "SECURITY"))         401
else if (contains(reason, "NOT_FOUND"))        404
else if (contains(reason, "METHOD_NOT_ALLOWED")) 405
else if (contains(reason, "BAD_REQUEST"))      400
else                                           500`;

        files['src/main/resources/dw/set-functional-error-payload.dwl'] = `%dw 2.0
output application/json
var errorReason = (error.errorType.namespace default "") ++ ":" ++ (error.errorType.identifier default "")
---
if (not isEmpty(vars.previousError))
{
    "type":    vars.previousError."type",
    origin:    vars.previousError.origin,
    timestamp: vars.previousError.timestamp,
    errors:    vars.previousError.errors default [] ++ [{ reason: errorReason, message: error.description }],
    data:      if (not isEmpty(vars.previousError.data)) vars.previousError.data else payload
}
else
{
    "type":    "Functional",
    origin:    vars.appName default "",
    timestamp: now() as LocalDateTime {format: "yyyy-MM-dd'T'HH:mm:ss"},
    errors:    [{ reason: errorReason, message: error.description }],
    data:      payload
}`;

        files['src/main/resources/dw/set-technical-error-payload.dwl'] = `%dw 2.0
output application/json
var errorReason = (error.errorType.namespace default "") ++ ":" ++ (error.errorType.identifier default "")
---
if (not isEmpty(vars.previousError))
{
    "type":    vars.previousError."type",
    origin:    vars.previousError.origin,
    timestamp: vars.previousError.timestamp,
    errors:    vars.previousError.errors default [] ++ [{ reason: errorReason, message: error.description }],
    data:      if (not isEmpty(vars.previousError.data)) vars.previousError.data else payload
}
else
{
    "type":    "Technical",
    origin:    vars.appName default "",
    timestamp: now() as LocalDateTime {format: "yyyy-MM-dd'T'HH:mm:ss"},
    errors:    [{ reason: errorReason, message: error.description }],
    data:      payload
}`;

        files['pom.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.dwforge</groupId>
  <artifactId>${cleanAppName}-integration</artifactId>
  <version>1.0.0</version>
  <packaging>mule-application</packaging>
  <properties>
    <app.runtime>4.6.0</app.runtime>
    <mule.maven.plugin.version>4.1.1</mule.maven.plugin.version>
  </properties>
  <dependencies>
${connDeps}
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.mule.tools.maven</groupId>
        <artifactId>mule-maven-plugin</artifactId>
        <version>\${mule.maven.plugin.version}</version>
        <extensions>true</extensions>
      </plugin>
    </plugins>
  </build>
  <repositories>
    <repository><id>anypoint-exchange-v3</id><url>https://maven.anypoint.mulesoft.com/api/v3/maven</url></repository>
    <repository><id>mulesoft-releases</id><url>https://repository.mulesoft.org/releases/</url></repository>
  </repositories>
</project>`;

        files['src/main/resources/log4j2.xml'] = `<?xml version="1.0" encoding="UTF-8"?>
<Configuration status="WARN">
  <Appenders>
    <Console name="Console" target="SYSTEM_OUT">
      <PatternLayout pattern="%-5p %d [%t] [txn: %X{transactionId}] [step: %X{step}] %c: %m%n"/>
    </Console>
  </Appenders>
  <Loggers>
    <AsyncLogger name="com.dwforge" level="INFO" additivity="false"><AppenderRef ref="Console"/></AsyncLogger>
    <Root level="WARN"><AppenderRef ref="Console"/></Root>
  </Loggers>
</Configuration>`;

      } catch (e) {
        console.error('Parse error:', e.message);
        return res.status(500).json({ error: 'Project generation failed. Please try again.' });
      }

      // Sprint 6: Output validator — check before delivery
      const validation = validateProject(projectData.files || {});
      projectData.validation = formatValidationReport(validation);

      return res.status(200).json(projectData);
    }

    // ── MODE: DATAWEAVE (Sprint 1-4: RAG-enhanced) ────────────────────────

    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: 'Prompt is required.' });
    }

    if (prompt.length > 8000) {
      return res.status(400).json({ error: 'Prompt too long. Please simplify your request.' });
    }

    // Sprint 2: Request intelligence — extract systems from prompt
    const srcMatch = prompt.match(/source\s*system[:\s]+([^\n]+)/i);
    const tgtMatch = prompt.match(/target\s*system[:\s]+([^\n]+)/i);
    const detectedSrc = srcMatch ? srcMatch[1].trim() : '';
    const detectedTgt = tgtMatch ? tgtMatch[1].trim() : '';

    // Sprint 3: RAG retrieval — inject pattern context
    const pattern = detectedSrc && detectedTgt ? retrievePattern(detectedSrc, detectedTgt) : null;
    const patternContext = buildPatternContext(pattern);

    const enrichedPrompt = patternContext
      ? `${prompt}\n\n${patternContext}`
      : prompt;

    const response = await callClaude(DATAWEAVE_SYSTEM_PROMPT, enrichedPrompt, 2500);
    if (!response.ok) return handleClaudeError(response, res);

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    console.error('DWForge generate error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ─── SHARED HELPERS ──────────────────────────────────────────────────────────

async function callClaude(systemPrompt, userContent, maxTokens) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  });
}

async function handleClaudeError(response, res) {
  const error = await response.json().catch(() => ({}));
  const status = response.status;
  const errMsg = (error.error?.message || '').toLowerCase();
  if (status === 401) return res.status(500).json({ error: 'Service authentication error. Please try again later.' });
  if (status === 429) {
    if (errMsg.includes('credit') || errMsg.includes('balance') || errMsg.includes('quota')) {
      return res.status(429).json({ error: 'DWForge has reached its daily limit. Please check back in a few hours.' });
    }
    return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }
  if (status === 529 || status === 503) return res.status(503).json({ error: 'Service temporarily busy. Please try again in a few seconds.' });
  if (status === 402) return res.status(503).json({ error: 'DWForge has reached its daily limit. Please check back in a few hours.' });
  return res.status(status).json({ error: 'Generation failed. Please try again.' });
}
