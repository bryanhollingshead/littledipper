# Health Data

> **Status: direction only.** Recorded 2026-10-22. See [open question 13](../OPEN-QUESTIONS.md).

## Why restructure

The owner's view: sharing health data into the [data commons](DATA-COMMONS.md) is among its most valuable uses, so diagnoses and treatments can be compared and treatment protocols shared effectively. Self-hosting means the owner decides who gets it.

Today's `health` domain is one flat list: a kind (allergy, condition, medication…), a free-text name and a free-text detail. That's fine for a personal note, but it **can't be compared across people**: "T2 diabetes", "type 2 diabetes" and "DM2" are three different strings. For a commons, and for handing records to a new doctor, entries need standard codes and a standard shape.

## Direction: follow FHIR and its code systems

Don't invent a health model. Health records already have a widely used standard:

- **Shape: HL7 FHIR** resources, mapped to Little Dipper domains:

  | Domain (proposed) | FHIR resource | Codes |
  |---|---|---|
  | Conditions (diagnoses) | Condition | SNOMED CT, ICD-10 |
  | Medications | MedicationStatement / MedicationRequest | RxNorm |
  | Allergies | AllergyIntolerance | SNOMED CT, RxNorm |
  | Immunizations | Immunization | CVX |
  | Procedures | Procedure | SNOMED CT, CPT |
  | Lab results and measurements | Observation | LOINC, UCUM units |
  | Visits | Encounter | |
  | Treatment plans and outcomes | CarePlan, plus patient-reported outcomes (Observation / QuestionnaireResponse) | |

- **Codes, not just text.** Each entry keeps the owner's own wording *and* a code from the standard system. Entry gets a search-as-you-type picker; an assistant can suggest the code.
- **Outcomes are what make protocols comparable.** "Condition X, treatment Y, and how it went" needs dated treatments linked to conditions, plus outcome measurements over time. The model needs links between records (a medication *for* a condition), which the domain engine doesn't have yet.

## Getting records in

Patients in the US have a legal right to their records through standard APIs (21st Century Cures Act). **SMART on FHIR patient access** is how Apple Health Records pulls from Epic MyChart and other hospital systems. A node could connect to the owner's providers the same way: the health counterpart of the bank connectors in [FINANCIAL-ACCOUNTS.md](FINANCIAL-ACCOUNTS.md). Medicare claims are available through Blue Button 2.0. Exporting FHIR would let owners hand their whole history to a new provider.

## Compatibility

The existing `health` domain stays (Commandment: upgrades never lose data). New coded domains are added next to it, with a one-time offer to move existing entries over, by kind, keeping the original text.

## Care points for a health commons

- **Health data is the most re-identifiable and the most harmful if it leaks:** a rare diagnosis plus a region and an age can point to one person, with consequences for insurance and employment. Self-hosting gives owners control over *whether* to share, not over what happens after. Once contributed, it can't be pulled back.
- The itemized approach from the commons doc still applies: coarse dates and ages, a region instead of an address, and rare conditions held back until enough contributors report them.
- **Per-study consent** may suit health better than one general switch. All of Us and Open Humans work this way: the owner joins a specific study and sees what it uses.
- **Law:** HIPAA mostly binds providers and insurers, not individuals sharing their own data. But a commons or app that holds health data has its own obligations (the FTC Health Breach Notification Rule in the US, and special-category data under GDPR). This needs legal review.

## Licensing note

SNOMED CT is free to use in member countries, including the US through the NLM's UMLS licence, but it isn't open for redistribution everywhere. ICD-10-CM, LOINC, RxNorm and CVX are freely usable. Check before shipping code lists inside an open-source release.
