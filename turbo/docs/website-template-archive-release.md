# Website template archive release

This document covers only the built-in Website template package release and
its R2 compatibility pins. Presentation runbook pins and the independent
static registry mechanism are outside this change.

## Pinned source and deterministic build

Source: `vm0-ai/Template-artifact@78dbe053b2b485d907d7e0116022ebdfe807038f`
from `Template-Website/archive`.

Build the deterministic archives and publication manifest from `turbo/`:

```bash
pnpm website-template-archives:build \
  --source-dir /path/to/Template-artifact/Template-Website/archive \
  --output-dir /tmp/website-template-archives \
  --source-commit 78dbe053b2b485d907d7e0116022ebdfe807038f \
  --storage-map scripts/website-template-storage-map.json
```

The candidate ids and digests below are deterministic build outputs; they are
not published until the review gate is approved. The builder uses portable tar
headers with mtimes removed. `publication.json` records the source commit,
storage id, version id, archive SHA-256, archive size, and every file hash.
Version ids are derived from the stable storage id and sorted file manifest, so
they can be checked before and after upload.

| Template          | R2 storage id                          | Previous version id                                                | Previous SHA-256                                                   | Candidate version id                                               | Candidate SHA-256                                                  |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `black-slabs`     | `81f4e53e-a086-4533-aba3-f3694348879b` | `eaca342df50857477c64a1ca73faffb4a1819879948fc8610ff095fae9fe3f22` | `8f30984e444283bf0322106a1099623346e153bc11d26e3044fbf61ef43514c3` | `63e7780407504c15df178658ef2f694baa23d0a2a4199f38ac07fd9a302f5dac` | `38b2f826a86901e113b6e96b52563a839b729fc025fa793b1816d6149221bcf9` |
| `blueprint-grid`  | `b571b9ef-e9ca-4f16-a4ca-9fe79549acb3` | `78988a658604a25feb259d54e4543bfe6d57f85efe7ad67737e02c794d25e491` | `97c2edd94467bc414f0d9fc27cafa048cb2a7aaba3df5159df519a2bb2b97a4e` | `89c5a11d4a769e880e59a277fe8af1f1c173752ceea7539680d00d5225b3b717` | `b5f058f3ec7881e642e31e44e7de1f94465bae783de7fc2d42727bbfd109fad2` |
| `coastal-hotel`   | `f556014b-5224-4257-9ab8-28daab351e98` | `3907cdbed6078702a058ed9c66c1cdeb76f83f1062efcf3b046cce0bd5c8ed06` | `9633475124da5728cbf99a7333b494f74842232faaf675bc7878a3ebcdf59bcb` | `e5ac62f1ebdf025470172c2ce8275833274de49f6300c427eef0c142523b1246` | `6bba8c10b85a248a475624767616280fa5d29b757ce230fb4115d746b8b61386` |
| `dot-matrix`      | `fd4bacaf-e8d2-497b-a60f-c79981560882` | `293a2bc33150ca1f39132a8235c5cf355944e8d3e213b5f7703237314a2ac449` | `f489a51fb99d8fadff8712d0406df06ac1a530116ebe612ab3f8605daa2bcce2` | `173d914b90d68648e9da9ee32cde12417fe55703b22f999b626b07f6053a7488` | `cfb8f891fa77eca2c3a58f1d95f046f873136f85c9c4a83400cba3a2ccca4ad9` |
| `frame-stack`     | `ed402508-e8cf-40f4-8908-72a315420075` | `efbf1788c8b084aa12b7cd48f7a3bf5fc9964d1e6115edbd9124f8cacfbfb3ca` | `4587e93da51652c0c16c2d0706e8437001305214e4e6b8b1c18a6538b3daa127` | `422a07c5431dc689f2a0f832ffd5085149c64de6575be2c435fef01e36ffdb83` | `642db1ff8e1c98e4c390245cb0fcda5ce29503721bc2a513c38448b9d4e2d01c` |
| `frosted-scatter` | `a93875fc-7370-4212-9c23-e8565977a8a9` | `c4507fd54d252dc905df36d99f23ab65a4d41185b78e62515ff3eb3d87a381a4` | `00e343ace0673ece5903a2b6abbad6bb960c17796e0cfa5cce0bcab7e6bcdd7b` | `02855a260801c5120ee62c04f3a0b9d4f4884caea89728264cc85c1f6a2d74ad` | `548a1faf423baa1c7c11befe41a54ae398cfb5c94df7f957eff108e2afcd613a` |
| `gallery-wall`    | `619d50a9-01fb-44dd-8a60-af3c97b557e7` | `9e81cd8b35f9f6374440cd3a4a8fc214db4a137962797df69bde46248c4e75f3` | `c90332053b24572feadecb3994925ed317957e1cb17b0080cfebc6f4d9e93bd1` | `26591a92b37e255dd8d565effc542115dd94292465e179c501c0518538cd27ce` | `b477b2f05c266eccbd2ab3b822744873dd8a31db03981283688549f2936bd5c6` |
| `glass-bloom`     | `49a24bc7-0515-431c-81c2-6f4ea7386e9c` | `52d38ebc1e62b974f7ab2f6dba8823b0a2f7c43d5c11d8079f32e3ff85df1e50` | `0c61488baa294fb13c58aa129e3ae99f0cd4ff9125459761a1b2c1390b860f93` | `297d1c1ed2639a3eead3212fcb3bf3c59ca80ee36562902cdec46ea8394b7398` | `8707cce50c5477d43912fd18aa5ab6973aae4fd2287a092967fa25bf4ea38e7c` |
| `serif-stack`     | `1fb5c01a-da4c-409a-8238-ed067309d670` | `adee3b87f670c52a3cc4971e5dd8795f8ca05690087caff4b0d8b32b9029bead` | `cf5137a7b6788f4d7cb24bda358a8e1971c0e7ed026d50e6cf292f6bf0cd0c14` | `165c2c576e7b2fccad2f490c6813e4705d5f87408fa24a8cec79d4ddf2392831` | `718d617efd92033a68c476e85bb9231b1e0ff580c08a1f6bedf1b86058e97f13` |
| `sticker-pop`     | `9b3511ce-a5ef-4b7a-ae3b-9d94919497ac` | `ddae2ff9236b0a4663dc19ad23b374488c0d4d9eddf9b5a4e8cad36011b0b420` | `2086113018279f28e23489cf7a0f3663c37a23210fb106c4ed48d8c19923f78f` | `c87a666429beb7d8fbaf3376c7229c701b53cdb36f4f714c6b45f0b6fdf3134a` | `8145c78f932ae942108fba00c5de367958f12b4c492d61bc1310892abe51ca66` |
| `warm-cards`      | `ac36455c-04e5-471c-9a14-b5b765c18ec2` | `0a87c99afe9cf24424aa1a1740a57cc3698e43f3c571b8ef1fd4560192f38746` | `2721c013f76e1b2eea09282269b33d7f143b7e83ee3e701e83a0fcf7773852dd` | `47a5c7f01a7395d5be86483291c26e5f51e3fa8258c0d69705379ea9fb21849f` | `a795ef022e672d364c7a966eb042d38e460d4dcb996d5eecb0647aac5dd259df` |

## Release verification

Before switching the client reference:

1. Upload each archive as a new version of its existing R2 storage. Do not
   overwrite or delete previous versions.
2. Download both the previous and candidate SHA pin through
   `zero resource pull`, and verify the API returns the expected version id.
3. Verify the downloaded archive SHA-256 and every file hash against the
   publication manifest.
4. Extract every package and run `node render.mjs sample-plan.json` in each
   template directory.
5. Generate and host a Website through both the legacy shared index and the
   independent Website index.
6. Merge and deploy the server-side pins and compatibility map, publish the
   append-only static index, and only then merge the client reference switch.

Keep the old index and old R2 versions for the full migration window. Any later
cleanup must be a separate, evidence-backed change after released clients no
longer depend on them.
