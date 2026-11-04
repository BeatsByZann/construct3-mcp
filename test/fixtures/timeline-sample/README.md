# timeline-sample fixture

Three loose files saved by the Construct 3 r495.2 editor: `project.c3proj`,
`Layout 1.json` and `Timeline 1.json`. It is no project folder (it has no
object type, event sheet or timeline folders), and no test loads it as a
project. Tests read `Timeline 1.json` as the shape of an editor-saved timeline
and copy it into a temporary project where they need one.
