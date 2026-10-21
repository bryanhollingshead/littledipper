/**
 * The built-in global data model. Each domain is its own endpoint (/api/v1/{id}),
 * its own grant in the contact admin, and its own scope for app keys.
 * Bump schemaVersion when a domain's parts change shape.
 */
import type { DomainDef, PartDef } from './types.js';

const o = (...pairs: string[]): [string, string][] => pairs.map((p) => {
  const [k, l] = p.split('=');
  return [k, l ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())];
});

// Reusable part groups
const ADDRESS: PartDef[] = [
  { key: 'street1', label: 'Street', type: 'text', required: true },
  { key: 'street2', label: 'Apartment, suite, unit', type: 'text' },
  { key: 'city', label: 'City', type: 'text', required: true },
  { key: 'region', label: 'State / region', type: 'text' },
  { key: 'postalCode', label: 'Postal code', type: 'text' },
  { key: 'country', label: 'Country', type: 'country', required: true },
];

type Def = Omit<DomainDef, 'builtIn' | 'schemaVersion'> & { schemaVersion?: number };

const DEFS: Def[] = [
  // ── identity ─────────────────────────────────────────────────────────
  {
    id: 'names', label: 'Names', noun: 'name', group: 'identity', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Every name you have used: legal, birth, married, aliases and nicknames, with when each applied.',
    title: '{full} ({kind})',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('legal', 'birth', 'married', 'previous_legal=Previous legal', 'alias', 'nickname', 'professional', 'religious') },
      { key: 'full', label: 'Full name', type: 'text', required: true },
      { key: 'given', label: 'Given name', type: 'text' },
      { key: 'middle', label: 'Middle name(s)', type: 'text' },
      { key: 'family', label: 'Family name', type: 'text' },
      { key: 'suffix', label: 'Suffix', type: 'text' },
      { key: 'reason', label: 'Reason for change', type: 'enum', options: o('birth', 'marriage', 'divorce', 'court_order=Court order', 'naturalization', 'other') },
    ],
  },
  {
    id: 'ids', label: 'Government IDs', noun: 'ID', group: 'identity', sensitivity: 'secret', dated: false, publicable: false,
    description: 'Passport, driver’s license, SSN and every other government-issued number. Numbers are encrypted.',
    title: '{kind} · {issuer}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, sensitivity: 'sensitive', options: o('passport', 'drivers_license=Driver’s license', 'state_id=State ID', 'national_id=National ID', 'ssn=Social Security number', 'tax_id=Tax ID', 'visa', 'residence_permit=Residence permit / green card', 'work_permit=Work permit', 'known_traveler=Known traveler number', 'military_id=Military ID', 'birth_certificate=Birth certificate', 'voter_registration=Voter registration', 'other') },
      { key: 'number', label: 'Number', type: 'text', required: true },
      { key: 'issuer', label: 'Issuing country', type: 'country', sensitivity: 'sensitive' },
      { key: 'authority', label: 'Issuing state / authority', type: 'text', sensitivity: 'sensitive' },
      { key: 'nameOnDocument', label: 'Name on document', type: 'text', sensitivity: 'sensitive' },
      { key: 'class', label: 'Class / category', type: 'text', sensitivity: 'sensitive', hint: 'License class, visa category…' },
      { key: 'issued', label: 'Issued', type: 'date', sensitivity: 'sensitive' },
      { key: 'expires', label: 'Expires', type: 'date', sensitivity: 'sensitive' },
    ],
  },
  {
    id: 'citizenship', label: 'Citizenship & residency status', noun: 'status', group: 'identity', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Citizenships and immigration statuses you hold or held.',
    title: '{status} · {country}',
    parts: [
      { key: 'country', label: 'Country', type: 'country', required: true },
      { key: 'status', label: 'Status', type: 'enum', required: true, options: o('citizen', 'national', 'permanent_resident=Permanent resident', 'temporary_resident=Temporary resident', 'visa_holder=Visa holder', 'refugee', 'asylee', 'other') },
      { key: 'acquiredBy', label: 'Acquired by', type: 'enum', options: o('birth', 'descent', 'naturalization', 'marriage', 'investment', 'other') },
    ],
  },
  {
    id: 'contact_methods', label: 'Contact methods', noun: 'contact method', group: 'identity', sensitivity: 'standard', dated: false, publicable: true,
    description: 'Emails, phones, social profiles and websites. The primary email and phone appear in your profile.',
    title: '{label}: {value}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('email', 'phone', 'social', 'website', 'messaging', 'other') },
      { key: 'label', label: 'Label', type: 'text', hint: 'Personal, Work, Instagram…' },
      { key: 'value', label: 'Value', type: 'text', required: true },
      { key: 'primary', label: 'Primary', type: 'boolean' },
    ],
  },
  // ── life ─────────────────────────────────────────────────────────────
  {
    id: 'residences', label: 'Residences', noun: 'residence', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Where you live and have lived. Your current one feeds “Current address”, “Current city” and “Country of residence”.',
    title: '{street1}, {city}',
    parts: [
      ...ADDRESS,
      { key: 'ownership', label: 'Ownership', type: 'enum', options: o('own', 'rent', 'family=With family', 'employer=Employer-provided', 'military', 'other') },
      { key: 'landlord', label: 'Landlord / property manager', type: 'contact' },
      { key: 'mailing', label: 'Also the mailing address', type: 'boolean' },
    ],
  },
  {
    id: 'relationships', label: 'Family & relationships', noun: 'person', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Spouse, partners, children, parents, dependents and emergency contacts.',
    title: '{name} ({relation})',
    parts: [
      { key: 'relation', label: 'Relation', type: 'enum', required: true, options: o('spouse', 'partner', 'ex_spouse=Former spouse', 'child', 'parent', 'sibling', 'grandparent', 'grandchild', 'guardian', 'dependent', 'emergency_contact=Emergency contact', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'contact', label: 'In your contacts', type: 'contact' },
      { key: 'birthDate', label: 'Date of birth', type: 'date' },
      { key: 'phone', label: 'Phone', type: 'phone' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'emergencyContact', label: 'Emergency contact', type: 'boolean' },
    ],
  },
  {
    id: 'pets', label: 'Pets', noun: 'pet', group: 'life', sensitivity: 'standard', dated: true, publicable: false,
    description: 'Animals in your care, their vet and microchip.',
    title: '{name} ({species})',
    parts: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'species', label: 'Species', type: 'text', required: true },
      { key: 'breed', label: 'Breed', type: 'text' },
      { key: 'birthDate', label: 'Born', type: 'date' },
      { key: 'microchip', label: 'Microchip number', type: 'text', sensitivity: 'sensitive' },
      { key: 'vet', label: 'Vet', type: 'contact' },
    ],
  },
  {
    id: 'travel', label: 'Travel history', noun: 'trip', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Countries visited and when. Visa and clearance forms ask for this.',
    title: '{country} · {purpose}',
    parts: [
      { key: 'country', label: 'Country', type: 'country', required: true },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'purpose', label: 'Purpose', type: 'enum', options: o('leisure', 'business', 'family', 'study', 'medical', 'transit', 'other') },
    ],
  },
  {
    id: 'life_events', label: 'Life events', noun: 'event', group: 'life', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'The moments that shaped your life story: moves, marriages, births, milestones.',
    title: '{title}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('birth', 'move', 'relationship', 'marriage', 'divorce', 'child', 'education', 'career', 'health', 'loss', 'achievement', 'travel', 'other') },
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'description', label: 'What happened', type: 'longtext' },
      { key: 'place', label: 'Place', type: 'text' },
    ],
  },
  // ── work ─────────────────────────────────────────────────────────────
  {
    id: 'employment', label: 'Employment', noun: 'job', group: 'work', sensitivity: 'sensitive', dated: true, publicable: true,
    description: 'Current and past employers, roles, supervisors and pay.',
    title: '{title} at {employer}',
    parts: [
      { key: 'employer', label: 'Employer', type: 'text', required: true },
      { key: 'title', label: 'Job title', type: 'text', required: true },
      { key: 'department', label: 'Department', type: 'text' },
      { key: 'type', label: 'Type', type: 'enum', options: o('full_time=Full-time', 'part_time=Part-time', 'contract', 'self_employed=Self-employed', 'internship', 'volunteer', 'seasonal', 'other') },
      { key: 'remote', label: 'Remote', type: 'boolean' },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'country', label: 'Country', type: 'country' },
      { key: 'workAddress', label: 'Work address', type: 'text' },
      { key: 'employerPhone', label: 'Employer phone', type: 'phone' },
      { key: 'supervisor', label: 'Supervisor', type: 'text' },
      { key: 'supervisorContact', label: 'Supervisor in your contacts', type: 'contact' },
      { key: 'mayContact', label: 'Employer may be contacted', type: 'boolean' },
      { key: 'employeeId', label: 'Employee ID', type: 'text', sensitivity: 'secret' },
      { key: 'startingPay', label: 'Starting pay (yearly)', type: 'money', sensitivity: 'secret' },
      { key: 'currentPay', label: 'Current or final pay (yearly)', type: 'money', sensitivity: 'secret' },
      { key: 'reasonForLeaving', label: 'Reason for leaving', type: 'text' },
      { key: 'description', label: 'What you did', type: 'longtext' },
    ],
  },
  {
    id: 'education', label: 'Education', noun: 'school', group: 'work', sensitivity: 'standard', dated: true, publicable: true,
    description: 'Schools, degrees and fields of study.',
    title: '{degree} · {institution}',
    parts: [
      { key: 'institution', label: 'Institution', type: 'text', required: true },
      { key: 'level', label: 'Level', type: 'enum', options: o('high_school=High school', 'vocational', 'associate', 'bachelor', 'master', 'doctorate', 'professional', 'certificate', 'other') },
      { key: 'degree', label: 'Degree / diploma', type: 'text' },
      { key: 'field', label: 'Field of study', type: 'text' },
      { key: 'completed', label: 'Completed', type: 'boolean' },
      { key: 'gpa', label: 'GPA', type: 'text', sensitivity: 'sensitive' },
      { key: 'honors', label: 'Honors', type: 'text' },
      { key: 'city', label: 'City', type: 'text' },
      { key: 'country', label: 'Country', type: 'country' },
      { key: 'studentId', label: 'Student ID', type: 'text', sensitivity: 'secret' },
    ],
  },
  {
    id: 'credentials', label: 'Licenses & certifications', noun: 'credential', group: 'work', sensitivity: 'standard', dated: false, publicable: true,
    description: 'Professional licenses and certifications, with numbers and expiry dates.',
    title: '{name} · {issuer}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('license', 'certification', 'clearance=Security clearance', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'issuer', label: 'Issued by', type: 'text', required: true },
      { key: 'number', label: 'Number', type: 'text', sensitivity: 'sensitive' },
      { key: 'region', label: 'State / region', type: 'text' },
      { key: 'issued', label: 'Issued', type: 'date' },
      { key: 'expires', label: 'Expires', type: 'date' },
      { key: 'url', label: 'Verification link', type: 'url' },
    ],
  },
  {
    id: 'military', label: 'Military service', noun: 'service period', group: 'work', sensitivity: 'sensitive', dated: true, publicable: true,
    description: 'Branch, rank and discharge.',
    title: '{branch} · {rank}',
    parts: [
      { key: 'country', label: 'Country', type: 'country', required: true },
      { key: 'branch', label: 'Branch', type: 'text', required: true },
      { key: 'rank', label: 'Highest rank', type: 'text' },
      { key: 'serviceNumber', label: 'Service number', type: 'text', sensitivity: 'secret' },
      { key: 'discharge', label: 'Discharge', type: 'enum', options: o('honorable', 'general', 'other_than_honorable=Other than honorable', 'medical', 'still_serving=Still serving', 'other') },
    ],
  },
  // ── health ───────────────────────────────────────────────────────────
  {
    id: 'health', label: 'Health', noun: 'health entry', group: 'health', sensitivity: 'secret', dated: true, publicable: false,
    description: 'Allergies, conditions, medications, immunizations, procedures, blood type and directives.',
    title: '{name} ({kind})',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, sensitivity: 'sensitive', options: o('allergy', 'condition', 'medication', 'immunization', 'procedure', 'blood_type=Blood type', 'measurement', 'directive=Advance directive', 'organ_donor=Organ donor', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true, sensitivity: 'sensitive' },
      { key: 'detail', label: 'Detail', type: 'longtext', hint: 'Severity, dosage, reaction…' },
      { key: 'provider', label: 'Provider', type: 'contact', sensitivity: 'sensitive' },
    ],
  },
  {
    id: 'insurance', label: 'Insurance', noun: 'policy', group: 'health', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Health, auto, home, life and every other policy.',
    title: '{kind} · {provider}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, options: o('health', 'dental', 'vision', 'auto', 'home', 'renters', 'life', 'disability', 'travel', 'pet', 'umbrella', 'business', 'other') },
      { key: 'provider', label: 'Provider', type: 'text', required: true },
      { key: 'policyNumber', label: 'Policy number', type: 'text', sensitivity: 'secret' },
      { key: 'memberId', label: 'Member ID', type: 'text', sensitivity: 'secret' },
      { key: 'groupNumber', label: 'Group number', type: 'text', sensitivity: 'secret' },
      { key: 'premium', label: 'Premium (yearly)', type: 'money' },
      { key: 'coverage', label: 'Coverage', type: 'text' },
      { key: 'phone', label: 'Claims phone', type: 'phone' },
      { key: 'agent', label: 'Agent', type: 'contact' },
    ],
  },
  // ── money ────────────────────────────────────────────────────────────
  {
    id: 'financial_accounts', label: 'Financial accounts', noun: 'account', group: 'money', sensitivity: 'secret', dated: true, publicable: false,
    description: 'Banks, cards, investments, retirement and loans. Only the last four digits are ever stored.',
    title: '{institution} {kind} ••{last4}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, sensitivity: 'sensitive', options: o('checking', 'savings', 'credit_card=Credit card', 'debit_card=Debit card', 'brokerage', 'retirement', 'hsa=HSA', 'loan', 'mortgage', 'crypto', 'other') },
      { key: 'institution', label: 'Institution', type: 'text', required: true, sensitivity: 'sensitive' },
      { key: 'nickname', label: 'Nickname', type: 'text', sensitivity: 'sensitive' },
      { key: 'last4', label: 'Last four digits', type: 'last4', sensitivity: 'sensitive' },
      { key: 'balance', label: 'Balance', type: 'money' },
      { key: 'jointWith', label: 'Joint with', type: 'text' },
    ],
  },
  {
    id: 'income', label: 'Income', noun: 'income entry', group: 'money', sensitivity: 'secret', dated: true, publicable: false,
    description: 'Income by source and year.',
    title: '{source}',
    parts: [
      { key: 'source', label: 'Source', type: 'text', required: true, sensitivity: 'sensitive' },
      { key: 'kind', label: 'Kind', type: 'enum', sensitivity: 'sensitive', options: o('salary', 'self_employment=Self-employment', 'investment', 'rental', 'pension', 'benefits', 'other') },
      { key: 'amount', label: 'Amount (yearly)', type: 'money', required: true },
    ],
  },
  {
    id: 'tax_returns', label: 'Tax returns', noun: 'return', group: 'money', sensitivity: 'secret', dated: false, publicable: false,
    description: 'One entry per filing: year, status and the numbers forms ask for.',
    title: '{year} {jurisdiction} return',
    parts: [
      { key: 'year', label: 'Tax year', type: 'number', required: true, sensitivity: 'sensitive' },
      { key: 'jurisdiction', label: 'Jurisdiction', type: 'text', required: true, sensitivity: 'sensitive', hint: 'US federal, Oregon…' },
      { key: 'filingStatus', label: 'Filing status', type: 'enum', sensitivity: 'sensitive', options: o('single', 'married_joint=Married filing jointly', 'married_separate=Married filing separately', 'head_of_household=Head of household', 'widow=Qualifying surviving spouse', 'other') },
      { key: 'agi', label: 'Adjusted gross income', type: 'money' },
      { key: 'taxPaid', label: 'Total tax', type: 'money' },
      { key: 'refund', label: 'Refund (or amount owed, negative)', type: 'money' },
      { key: 'preparer', label: 'Preparer', type: 'contact', sensitivity: 'sensitive' },
    ],
  },
  // ── things ───────────────────────────────────────────────────────────
  {
    id: 'vehicles', label: 'Vehicles', noun: 'vehicle', group: 'things', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Cars, bikes and boats you own or owned.',
    title: '{year} {make} {model}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('car', 'motorcycle', 'truck', 'rv=RV', 'boat', 'bicycle', 'other') },
      { key: 'make', label: 'Make', type: 'text', required: true },
      { key: 'model', label: 'Model', type: 'text', required: true },
      { key: 'year', label: 'Year', type: 'number' },
      { key: 'color', label: 'Color', type: 'text' },
      { key: 'vin', label: 'VIN / hull number', type: 'text' },
      { key: 'plate', label: 'Plate', type: 'text' },
      { key: 'plateRegion', label: 'Registered in', type: 'text' },
      { key: 'registrationExpires', label: 'Registration expires', type: 'date' },
    ],
  },
  {
    id: 'property', label: 'Property & valuables', noun: 'item', group: 'things', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Homes, land and valuables, with serial numbers for insurance.',
    title: '{name}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('home', 'land', 'electronics', 'jewelry', 'art', 'instrument', 'collectible', 'other') },
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'serialNumber', label: 'Serial number', type: 'text' },
      { key: 'purchasePrice', label: 'Purchase price', type: 'money' },
      { key: 'estimatedValue', label: 'Estimated value', type: 'money' },
    ],
  },
  {
    id: 'memberships', label: 'Memberships & loyalty', noun: 'membership', group: 'things', sensitivity: 'standard', dated: true, publicable: true,
    description: 'Frequent flyer, hotel and loyalty numbers, clubs, associations and subscriptions.',
    title: '{organization}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', options: o('frequent_flyer=Frequent flyer', 'hotel', 'loyalty', 'club', 'association=Professional association', 'union', 'subscription', 'other') },
      { key: 'organization', label: 'Organization', type: 'text', required: true },
      { key: 'memberNumber', label: 'Member number', type: 'text', sensitivity: 'sensitive' },
      { key: 'tier', label: 'Tier / status', type: 'text' },
      { key: 'cost', label: 'Cost (yearly)', type: 'money' },
    ],
  },
  {
    id: 'online_accounts', label: 'Online accounts', noun: 'account', group: 'things', sensitivity: 'sensitive', dated: true, publicable: false,
    description: 'Which services you use and under what username. Never passwords: keep those in a password manager.',
    title: '{service} · {username}',
    parts: [
      { key: 'service', label: 'Service', type: 'text', required: true },
      { key: 'username', label: 'Username / sign-in email', type: 'text' },
      { key: 'url', label: 'Address', type: 'url' },
      { key: 'twoFactor', label: 'Two-factor on', type: 'boolean' },
      { key: 'recoveryHint', label: 'Where recovery codes are kept', type: 'text', sensitivity: 'secret', hint: 'A location, never the codes themselves' },
    ],
  },
  {
    id: 'legal', label: 'Legal documents', noun: 'document', group: 'money', sensitivity: 'secret', dated: true, publicable: false,
    description: 'Will, powers of attorney, trusts, beneficiary designations and where the originals are.',
    title: '{title}',
    parts: [
      { key: 'kind', label: 'Kind', type: 'enum', required: true, sensitivity: 'sensitive', options: o('will', 'power_of_attorney=Power of attorney', 'healthcare_proxy=Healthcare proxy', 'trust', 'beneficiary=Beneficiary designation', 'prenup=Prenuptial agreement', 'court_order=Court order', 'deed', 'other') },
      { key: 'title', label: 'Title', type: 'text', required: true, sensitivity: 'sensitive' },
      { key: 'attorney', label: 'Attorney', type: 'contact', sensitivity: 'sensitive' },
      { key: 'originalLocation', label: 'Where the original is', type: 'text' },
      { key: 'parties', label: 'People named', type: 'longtext' },
    ],
  },
  // ── personal ─────────────────────────────────────────────────────────
  {
    id: 'preferences', label: 'Preferences', noun: 'preference', group: 'personal', sensitivity: 'standard', dated: false, publicable: true,
    description: 'Sizes, food, gifts, how you like to be contacted. What makes an assistant feel like it knows you.',
    title: '{name}: {value}',
    parts: [
      { key: 'category', label: 'Category', type: 'enum', required: true, options: o('clothing', 'food', 'drink', 'gifts', 'travel', 'communication', 'accessibility', 'entertainment', 'work', 'other') },
      { key: 'name', label: 'Preference', type: 'text', required: true, hint: 'Shirt size, coffee order, seat…' },
      { key: 'value', label: 'Value', type: 'text', required: true },
    ],
  },
];

export const BUILT_IN_DOMAINS: DomainDef[] = DEFS.map((d) => ({ ...d, builtIn: true, schemaVersion: d.schemaVersion ?? 1 }));

/** Paths under /api/v1 that domains may never use. */
export const RESERVED = new Set([
  'node', 'auth', 'owner', 'contacts', 'federation', 'public-profile', 'keys', 'audit', 'export', 'catalog', 'timeline', 'attention', 'records', 'files', 'domains',
]);
