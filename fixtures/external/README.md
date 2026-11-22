# External sample fixture

Five real, public GenBank records for one marker, used to prove that the Payload plugin's external sample fields carry real records from an import (`packages/payload/test/import.test.ts`). Not for scientific use and not a reference panel.

| File | What it is |
| --- | --- |
| `cytb-chelonoidis-carbonarius.gb` | Five GenBank flat files, partial cytochrome b (`cytb`) genes of 719 bases from *Chelonoidis carbonarius*, one submission from a Colombian university. |

## The records

`PQ562694.1`, `PQ562693.1`, `PQ562692.1`, `PQ562691.1` and `PQ562690.1`. Each names its country (Colombia) and no coordinates or locality. None gives a specimen voucher, collector or collection date, so the import test makes an edited copy for those (labeled in the test).

## Where it came from

- Source: NCBI nuccore, through E-utilities `efetch` with `rettype=gb` and `retmode=text`, ids `2863947732,2863947730,2863947728,2863947726,2863947724,2863947722` (the first six hits of an `esearch` for `Chelonoidis carbonarius[ORGN]` AND `cytochrome b[TITL]`). The first five records of the answer are kept, unchanged, in the order NCBI returned them. The sixth (`PQ562689.1`) was left out.
- Fetched: 2026-11-21, five requests in all, spaced more than a second apart, with a generic client name and no contact detail.
- SHA-256 of `cytb-chelonoidis-carbonarius.gb`: `975f6bd8c65e6a7804e32347451c7a3daa77ef77a618e683c22d5f18aa156b56`.

## License

GenBank records carry no license statement, so the import stores `dataLicense: unknown`. That fails closed: the plugin keeps a pointer to the record and refuses a cached copy. The records are public. Nothing here is a Captive Origins sample, animal or result.
