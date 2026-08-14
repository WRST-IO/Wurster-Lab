---
title: Undercover Wurst
group: Runtime & Format
groupOrder: 2
order: 6
---
# Undercover Wurst

A Wurst may wear a PNG as civilian clothing.

MeatGrinder embeds the complete WRST stream in private PNG `wuSt` chunks before `IEND`. The output remains a valid PNG and ordinary image viewers display the carrier image.

Wurster detects the private chunks and maps them back into a virtual WRST byte stream.

The GUI accepts PNG or JPEG as input. JPEG is converted to PNG before the Wurst is embedded.

Carrier mode is camouflage, not cryptography. Anyone deliberately inspecting the PNG structure can discover the private chunks. Use WurstKey or a sealed personal/shared PigFS realm when confidentiality matters.

Do not re-save an Undercover Wurst through an image editor. Editors and optimizers may discard unknown private chunks, leaving a perfectly healthy picture and one tragically deceased Wurst.
