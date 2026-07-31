# AJRM Marine Logger — retired

AJRM Marine Logger was retired in version `0.7.0`.

Recording, canonical-input storage, fixed `1x` replay, recomputed-output
capture, verification, and voyage ZIP construction now belong to
**AJRM Marine Capture v0.7.0 or later**.

Logger v0.7.0 is deliberately inert and disabled by default. It exists only
to give an explicit migration message to an existing installation. Remove
this package after installing the replacement Capture release.

Older Logger/Capture voyages remain downloadable and viewable, but Capture
does not replay them through a runtime compatibility layer. If an old voyage
is important, convert its sensor input once into Capture's canonical input
format.

> **Alpha software:** AJRM Marine Suite diagnostic software must not be relied
> upon for navigation or safety.
