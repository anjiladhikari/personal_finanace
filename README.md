# personal_finanace
## Parsers are frozen

`commbank_parser.py` and `ing_parser.py` are regression-frozen after Step 4.
Any future parser change must run the complete real-PDF regression suite
(`tests/test_parser_regression.py`, which needs the private, git-ignored
`test_pdfs/commbank/` and `test_pdfs/ing/` folders) and every statement must
still pass:

    python3 -m pytest
