# WD-ACCESS-01 / WD-ACCESS-02: CRM "View Documents" button (PENDING configuration task)

Status: **not implemented, not verified.** Creating a CRM custom button and a Deluge function is CRM configuration that needs Sandbox administrator access this work did not have (and, for Production, Class 3 approval). No claim of completion is made.

## Approved rules
Staff reach the documents from the Requests record; WorkDrive enforces authentication and membership of the approved staff group; all members may see the whole collection (MVP); no public or unrestricted links; CRM button visibility is not authorisation; medical and body-photo files are confined to that group; no tokens or document contents in logs.

## Proposed MVP
Button on `Requests` -> Deluge function reads the Request's `uniqueformkey`, finds the single WorkDrive folder with exactly that name directly under the approved root, and returns the **private** folder permalink. The staff member then signs in to WorkDrive; WorkDrive decides.

Rules for the function: zero or several matching folders is an error (never guess); only the key of the current record is used; return no document names or content; do not create share links.

## Facts that must be verified in the Sandbox before this is built
1. A CRM custom button can call a function that uses a WorkDrive connection (Deluge `invokeurl` with a connection). Documentation reached did not state **whose permissions** the connection uses at run time.
2. The connection needs only read scopes (`WorkDrive.files.READ`, possibly `WorkDrive.teamfolders.READ`).
3. The private folder permalink pattern (`https://workdrive.zoho.<dc>/folder/<id>`) is valid in that data centre. The repository itself only uses `/file/<id>` for documents.
4. Permission enforcement with two test identities: a member of the staff group opens the folder; a non-member signed in to WorkDrive gets denied; an anonymous browser is sent to sign-in. Record the actual results.
5. Whether staff can browse above the folder (they can, by design of WD-ACCESS-02).

## Pending task list
* Sandbox admin: create the WorkDrive connection (read-only scopes), the function, the button on Requests, restricted by profile (convenience only).
* WorkDrive admin: create the staff group, grant it access to the approved root Team Folder only; create one non-member test identity.
* Run checks 1-5 above and attach the evidence.
