# Billing Management — Project Instructions

## 1. Mandatory Workflow
- Before changing code, inspect the existing implementation and relevant documentation.
- Read README.md, docs/KNOWN_ISSUES.md, and the relevant documentation for the task.
- Inspect existing patterns, dependencies, database migrations, and tests before proposing changes.
- Make the smallest safe change that solves the actual problem.
- Never rewrite working modules or replace project architecture without a demonstrated need.
- Ask for clarification before destructive, irreversible, or business-critical changes.
- Do not claim that a bug is fixed unless the change has been implemented and appropriately verified.

## 2. Skill Discovery and Usage
- Discover available skills from the global and project-local skill directories supported by OpenCode.
- Select skills according to the current task instead of loading every skill for every request.
- Load relevant skills using OpenCode's supported skill-loading mechanism before implementing substantial changes.
- Read the complete relevant SKILL.md instructions and any supporting files required by those instructions.
- For Neon work, prefer the applicable project-local Neon skills.
- For frontend work, consider frontend-ui-engineering, ui-ux-pro-max, design-system, and ui-styling.
- For debugging, consider debugging-and-error-recovery and code-review-and-quality.
- For tests, consider test-driven-development and browser-testing-with-devtools.
- For security work, consider security-and-hardening.
- For deployment, consider ci-cd-and-automation and shipping-and-launch.
- Report skills actually loaded separately from skills merely discovered.
- Never claim a skill was loaded or followed if it was not.

## 3. Project Technology
- Preserve the existing React, React Router, TypeScript, and Vite architecture.
- Preserve the existing Neon PostgreSQL, Neon Auth, Neon Functions, and Neon Object Storage integrations.
- Use existing project abstractions and dependencies before introducing alternatives.
- Follow the existing TypeScript strictness and ESLint conventions.
- Do not migrate the application to another framework, database, authentication provider, or storage service without explicit authorization.

## 4. Database and Neon
- Read the relevant SQL migrations, database documentation, and Neon skill instructions before database changes.
- Preserve existing schema conventions, foreign keys, constraints, indexes, transactions, and data integrity.
- Treat database migrations as production-sensitive.
- Never silently rewrite, delete, reorder, or squash existing migrations.
- Follow the existing migration naming and ordering conventions.
- Do not apply migrations to production without explicit authorization.
- Use a dedicated test database or Neon test branch for database integration tests.
- Never use production data for destructive testing.
- Preserve existing Row-Level Security (RLS), grants, authorization checks, and security-definer function protections.
- The browser-facing Neon Data API with RLS is an existing architectural choice. Do not replace it with server functions merely because an agent skill recommends a different architecture.
- Evaluate and document security implications before proposing changes to database access patterns.
- Use parameterized SQL for values; never concatenate untrusted input into SQL.
- Preserve exact quantity precision and monetary calculation rules.
- Use the existing Decimal.js and database numeric conventions for financial calculations where applicable.
- Verify permissions for every new table, RPC, and database operation.

## 5. Authentication and Authorization
- Preserve the existing Neon Auth and JWT verification flow.
- Verify authorization on the server or database boundary; do not rely only on hidden UI controls.
- Enforce the existing admin, staff, and viewer role rules.
- Test unauthorized access and privilege boundaries when changing authentication or permissions.
- Never expose private keys, database credentials, OAuth secrets, or OCR API keys to browser code.

## 6. Security and Privacy
- Treat customer information, GSTINs, invoices, billing records, and uploaded documents as sensitive business data.
- Never print, expose, commit, or copy real secrets into source files, logs, prompts, or reports.
- Never read or display .env contents unless explicitly necessary and authorized.
- Never put secrets in VITE_* variables; these variables can be exposed to frontend bundles.
- Validate user input on trusted server-side boundaries.
- Apply appropriate authorization, file-size limits, file-type checks, and storage-path validation to uploads.
- Preserve CORS restrictions and existing authentication checks.
- Do not disable security controls merely to make a test pass.
- Add regression tests for security-sensitive fixes when practical.

## 7. Billing and Business Rules
- Preserve existing invoice, customer, product, tax, quantity, and financial calculation behavior unless the requested feature explicitly requires a change.
- Avoid floating-point arithmetic for money where exact decimal arithmetic is required.
- Maintain data consistency across bills, customers, products, and related records.
- Treat invoice cancellation, credit notes, partial payments, and finalized-document edits as business-critical workflows.
- Consult docs/KNOWN_ISSUES.md before changing an area with documented limitations.
- Do not invent tax, accounting, or statutory requirements. Identify assumptions and request clarification where necessary.

## 8. Frontend and User Experience
- Follow the existing design system and component patterns.
- Build responsive interfaces for desktop, tablet, and mobile.
- Provide appropriate loading, empty, success, validation, and error states.
- Preserve accessibility, keyboard navigation, and form usability.
- Avoid unnecessary dependencies, duplicate components, and large UI rewrites.
- Ensure that user-facing errors are helpful without exposing secrets or internal stack traces.

## 9. Testing and Verification
- Inspect package.json before choosing commands.
- Run targeted tests relevant to the changes.
- Use npm run verify for the complete project verification gate when feasible.
- Before modifying database schema, RLS, RPCs, or authorization behavior, inspect and use the database test workflow where available.
- npm run test:db may require DATABASE_URL_TEST and a dedicated Neon test branch. Verify the target before running it.
- Do not run destructive tests against production.
- If a command fails, investigate the failure instead of hiding or bypassing it.
- Report commands actually executed and their actual results.
- Distinguish passing tests from tests not run, blocked tests, and unverified behavior.

## 10. Dependencies and Configuration
- Do not install, remove, or upgrade packages without a clear reason.
- Preserve package-lock.json consistency when dependencies genuinely change.
- Inspect existing configuration before editing it.
- Do not overwrite environment files, Neon configuration, MCP settings, or other agent configurations unnecessarily.
- Do not create duplicate configuration files when an existing supported mechanism is sufficient.

## 11. Documentation and Existing Issues
- Consult README.md and relevant files under docs/ before implementation.
- Treat docs/KNOWN_ISSUES.md as the reference for previously documented limitations.
- Update documentation when a meaningful behavior, configuration, migration, or workflow changes.
- Keep migration documentation consistent with the actual files under db/migrations/.
- Distinguish previously documented issues from newly discovered problems.

## 12. Git and File Hygiene
- Inspect Git status before editing when the directory is a Git repository.
- Never overwrite unrelated user changes.
- Do not delete diagnostic files, generated artifacts, user data, or untracked files without authorization.
- Keep generated files and temporary diagnostic output out of source control where appropriate.
- Never initialize a Git repository, commit, push, or deploy without explicit authorization.

## 13. Final Report
After implementation, report:
1. What changed and why.
2. Which files were modified or created.
3. Which skills were actually loaded.
4. Which tests and verification commands were executed.
5. Actual pass/fail results.
6. Security, migration, and compatibility considerations.
7. Remaining issues and tests not run.

Do not claim deployment, database changes, or successful verification unless they actually occurred.
