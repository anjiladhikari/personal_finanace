# personal_finanace
## Parsers are frozen

`commbank_parser.py` and `ing_parser.py` are regression-frozen after Step 4.
Any future parser change must run the complete real-PDF regression suite
(`tests/test_parser_regression.py`, which needs the private, git-ignored
`test_pdfs/commbank/` and `test_pdfs/ing/` folders) and every statement must
still pass:

    python3 -m pytest

## Run the API

    python3 -m venv .venv && . .venv/bin/activate
    pip install -r requirements.txt
    uvicorn api:app --reload

The API uses `data/finance.db` (git-ignored) and creates it on first start.
Uploaded PDFs are only ever written to a temporary file and deleted after parsing.
