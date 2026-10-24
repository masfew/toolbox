# Future Ideas

The Future Ideas section of a plan (the last of its core sections, see making.md), what its cards and buttons do, and adding ideas to it.

## Markup and Behaviour

Under the heading **Future Ideas**: ideas that could come later but aren't part of the plan yet. The user goes through them with each card's **Accept** (✓) and **Reject** (✕) buttons, can write changes for Claude with its **Edit** (pencil) button, and later asks Claude to plan the accepted ones and make the changes (see [selections.md](selections.md)).

- **Markup:** keep the template's `<p class="block-intro" data-feature-hint hidden></p>` and put every card inside `<div class="feature-board" id="feature-board">`, in the order the ideas came up. Don't write the groups, buttons or "waiting" label: the script adds them.
- **Idea card:** `<article class="idea-card" data-feature="…">` holding a `<div class="idea-text">` with a short name (`<h3>`) and one or two sentences (`<p>`).
- **Idea details:** when there's more to an idea than those sentences hold (options to choose between, a recommendation, requirements, open questions, notes from the conversation), put it in a `<div class="idea-more prose">` after the `.idea-text`. The card then shows a chevron, and clicking the card's text or the chevron drops the details down. Keep the one or two sentences as the summary, and write the details like a step body: short paragraphs, short lists, `<h5>` subheadings such as **Options**, **Recommendation** or **Must**, and a `.note` for a caveat. Leave the div out when there's nothing more to say. Detail never turns an idea into a planned feature; it waits on the card until the feature is planned.

  ```html
  <article class="idea-card" data-feature="kept-programs">
    <div class="idea-text">
      <h3>Kept Programs</h3>
      <p>Let programs a session starts keep running after the session closes.</p>
    </div>
    <div class="idea-more prose">
      <h5>Options</h5>
      <ul>
        <li><strong>A (recommended):</strong> …</li>
        <li><strong>B:</strong> …</li>
      </ul>
      <h5>Must</h5>
      <p>…</p>
    </div>
  </article>
  ```
- **Feature id:** `data-feature` is a short lowercase slug of the name with hyphens (`plan-index`). It's the key the user's choice is saved under, so never change or reuse it once published.
- **Groups:** the script sorts the cards into three groups:
  - **Pending:** planned features that aren't finished (in the user's saved order, else by F number), then planned features whose steps were all skipped (approved work set aside to come back to, so never Rejected), then accepted features waiting to be planned, then undecided ideas.
  - **Completed:** planned features whose steps are all done.
  - **Rejected:** ideas the user rejected.
- **Buttons:** each idea card has three square icon buttons: a tick (Accept, green when pressed), a cross (Reject, red when pressed) and a pencil (Edit, orange). Clicking Accept or Reject saves the choice straight away. Clicking the pressed button again clears it. The buttons only appear for the owner and editors; anyone else sees the choices without them.
- **Recover:** a rejected idea card shows a single **Recover** button, styled like Reset, in place of Accept, Reject and Edit. Clicking it saves the feature as undecided, which puts it back in Pending. The next time the script runs, it drops the card's `data-decision="reject"`.
- **Edits:** the pencil opens a "Changes for Claude" box along the bottom of the card, where the user writes what they want changed about that feature. It saves as they type, in the `edit` field of the feature's document in the `features` collection, and the pencil stays orange while the card holds an edit. Planned features have a pencil too, beside the status pill, until one of their steps is In progress or Done (or every step is Skipped): the feature is then locked, and its pencil goes. Claude makes the changes and clears the edit when the user says they've updated their future ideas (see [selections.md](selections.md)).
- **Reorder:** each planned feature in Pending has a drag handle (two columns of dots) just outside the left edge of its header. On narrow screens those cards move in a little to make room for it. Dragging it, or focusing it and pressing the up and down arrow keys, moves it among the other planned features in Pending and saves the new order straight away. On a database plan it's saved as an update record and the page renumbers the planned features at once, so there's nothing for Claude to do. On an older plan it's saved in the `_order` document of the `features` collection, and the page says a new order is waiting until Claude renumbers them (see [older-selections.md](older-selections.md)). Ideas, accepted features not yet planned, skipped features, and Completed and Rejected cards can't be reordered. Like the buttons, the handles only appear for the owner and editors.
- **Reset:** a planned feature whose steps are all Not started has a **Reset** button beside its status pill. Clicking it saves the feature as undecided. Until Claude takes it out for good, the page shows it as an idea card again, with Accept and Reject and a "Pending reset" label, and greys out its rows in the plan overview, with a "Pending reset" label under the phase name (they no longer count towards the progress label). Clicking Accept again before then brings the planned card back. Claude takes it out when the user says they've updated their future ideas (see [selections.md](selections.md)).
- **None yet:** if there are no ideas yet, put a single `<p>` saying so inside the board, and no cards.

## Adding future ideas

When the user asks to add something as a future idea ("add this to the future ideas", "add it as a future idea", or the same with "future feature"), add it as a new undecided idea at the end of the board. On a database plan that's a record update (see SKILL.md): `Write` it as `## Idea: Name {#id}`, its one or two sentences, then any details, and send `plan.py record … --add <scratchpad>/add.txt`. On an older plan, see [older-selections.md](older-selections.md).

- **The id** is a short lowercase slug of the name with hyphens (`plan-index`), the key the user's choice is saved under: never change or reuse it once it's on the board.
- **Don't plan it on the way in, unless asked.** Give it no F number, overview row or steps, and write nothing to the `features` collection, however much detail the user gives (that goes in its details). Only the user's own Accept, followed by Feature Selections, plans an idea, or the user asking for it to be accepted or planned straight away (see [selections.md](selections.md)). Never stop at an accepted idea card after such a request: "Accepted · waiting to be planned" means the job is half done.
