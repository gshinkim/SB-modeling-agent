"""Web search + scrape CLI for the AI agent: `web.py <op> <arg>`, plain text on stdout.

ops: search, fetch, pubmed, brenda, biomodels, sabio, jws (see OPS at the bottom).
HTTP goes through Scrapling's static Fetcher (curl_cffi with browser TLS + headers),
no downloaded browser. Output is capped at CAP chars. Any failure prints one
`ERROR: ...` line and exits 1, never a traceback.
"""
import hashlib, io, json, logging, os, re, sys, tempfile, time, urllib.parse
import xml.etree.ElementTree as ET

logging.disable(logging.CRITICAL)       # scrapling logs every fetch; keep the streams clean

from scrapling.fetchers import Fetcher
from scrapling.parser import Selector

CAP = 12000
TIMEOUT = 30
EC = r'\d+\.\d+\.\d+\.n?\d+'
SKIP = ('script', 'style', 'nav', 'noscript', 'header', 'footer', 'svg', 'form', 'iframe')


def get(url, allow=(), **kw):
    """GET (or POST with data=) with a hard timeout; HTTP errors raise unless in `allow`."""
    r = (Fetcher.post if 'data' in kw else Fetcher.get)(url, timeout=TIMEOUT, retries=2, **kw)
    if r.status >= 400 and r.status not in allow:
        ctype = r.headers.get('content-type', '')
        detail = r.body[:300].decode('utf-8', 'replace') if 'json' in ctype else ''
        raise RuntimeError('HTTP %d from %s %s' % (r.status, url.split('?')[0], detail))
    return r


def qs(**q):
    return urllib.parse.urlencode(q)


def tidy(text):
    """Collapse runs of spaces and drop blank lines."""
    lines = (re.sub(r'[ \t\r\f\v\xa0]+', ' ', l).strip() for l in text.splitlines())
    return '\n'.join(l for l in lines if l)


def text_of(sel):
    """Exact inline text of an element (keeps the spaces between <b> pieces)."""
    return tidy(sel.get_all_text(separator='', valid_values=False)).replace('\n', ' ')


def page_text(page):
    # ' ' joins inline pieces; block breaks survive as the newlines already in the markup
    text = tidy(page.get_all_text(separator=' ', ignore_tags=SKIP, valid_values=False))
    return re.sub(r'(?<=\() | (?=[,.;:!?)])', '', text)       # undo spaces the joiner put around <a>


def cap(text, n=CAP):
    text = text.strip()
    return text if len(text) <= n else text[:n].rstrip() + '\n[truncated]'


# --- general web --------------------------------------------------------------

def search(query):
    # the html.duckduckgo.com endpoint serves a bot challenge to curl; lite does not (yet)
    r = get('https://lite.duckduckgo.com/lite/?' + qs(q=query))
    hits = []
    for tr in r.css('tr'):
        a = tr.css('a.result-link')
        if a:
            href = a[0].attrib.get('href', '')
            url = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get('uddg', [href])[0]
            if 'duckduckgo.com/y.js' not in url:            # ads
                hits.append([text_of(a[0]), url, ''])
        elif hits and tr.css('td.result-snippet'):
            hits[-1][2] = text_of(tr.css('td.result-snippet')[0])
    if not hits:
        if 'bots use DuckDuckGo' in r.get_all_text():
            raise RuntimeError('DuckDuckGo served a bot challenge; retry in a minute or fetch a known URL')
        return 'No web results for %r' % query
    return '\n\n'.join('%d. %s\n   %s\n   %s' % (i, t, u, s) for i, (t, u, s) in enumerate(hits[:10], 1))


def fetch(url):
    if not re.match(r'https?://', url):
        raise ValueError('fetch needs an http(s) URL, got %r' % url)
    r = get(url)
    ctype = r.headers.get('content-type', '').lower()
    if 'pdf' in ctype or r.body[:5] == b'%PDF-':
        from pypdf import PdfReader
        text = ''
        for p in PdfReader(io.BytesIO(r.body)).pages:
            text += (p.extract_text() or '') + '\n'
            if len(text) > CAP:
                break
        return tidy(text)
    if 'html' in ctype or (not ctype and r.body.lstrip()[:1] == b'<'):
        return page_text(r)                  # <title> is already the first line
    if 'json' in ctype or 'xml' in ctype or ctype.startswith('text/'):
        return r.body.decode(r.encoding or 'utf-8', 'replace')
    raise RuntimeError('%s is %s, not text' % (url, ctype or 'unknown content'))


# --- literature -----------------------------------------------------------------

def eutils(tool, **q):
    q['db'] = 'pubmed'
    if os.environ.get('PUBMED_API_KEY'):
        q['api_key'] = os.environ['PUBMED_API_KEY']
    return get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/%s.fcgi?%s' % (tool, qs(**q)))


def pubmed(query):
    ids = eutils('esearch', term=query, retmax=10, sort='relevance', retmode='json').json()['esearchresult']['idlist']
    if not ids:
        return 'No PubMed results for %r' % query
    summ = eutils('esummary', id=','.join(ids), retmode='json').json()['result']
    out = []
    for i in ids:
        s = summ.get(i, {})
        names = [a['name'] for a in s.get('authors', [])]
        who = ', '.join(names[:3]) + (' et al.' if len(names) > 3 else '')
        out.append('PMID %s | %s | %s %s | %s\n  https://pubmed.ncbi.nlm.nih.gov/%s/'
                   % (i, s.get('title', ''), s.get('source', ''), s.get('pubdate', '')[:4], who, i))
    abstracts = eutils('efetch', id=','.join(ids[:3]), rettype='abstract', retmode='text').body
    return '\n'.join(out) + '\n\n--- abstracts (top 3) ---\n' + abstracts.decode('utf-8', 'replace').strip()


# --- kinetics / model databases ---------------------------------------------------

BRENDA = 'https://www.brenda-enzymes.org/'
# SOAP op -> (value field, ligand field); every op also takes ecNumber, organism, commentary...
SOAP_OPS = {'getKmValue': ('kmValue', 'substrate'), 'getTurnoverNumber': ('turnoverNumber', 'substrate'),
            'getKcatKmValue': ('kcatKmValue', 'substrate'), 'getKiValue': ('kiValue', 'inhibitor')}
TABLES = ('KM VALUE', 'TURNOVER NUMBER', 'kcat/KM VALUE', 'Ki VALUE')
ROWS = 25                                # per table, so four tables fit under CAP


def brenda_soap(ec, organism):
    email, pw = os.environ['BRENDA_EMAIL'], hashlib.sha256(os.environ['BRENDA_PASSWORD'].encode()).hexdigest()
    esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;')
    out = []
    for op, (val, lig) in SOAP_OPS.items():
        parts = [('email', email), ('password', pw), ('ecNumber', 'ecNumber*' + ec), ('organism', 'organism*' + organism)]
        parts += [(k, k + '*') for k in (val, val + 'Maximum', lig, 'commentary', 'ligandStructureId', 'literature')]
        body = ''.join('<%s xsi:type="xsd:string">%s</%s>' % (k, esc(v), k) for k, v in parts)
        env = ('<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'
               ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
               ' xmlns:ns="ws.brenda" soap:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">'
               '<soap:Body><ns:%s>%s</ns:%s></soap:Body></soap:Envelope>' % (op, body, op))
        r = get(BRENDA + 'soap/brenda_server_zeep.php', allow=(500,), data=env,
                headers={'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': 'ws.brenda#' + op})
        root = ET.fromstring(r.body)
        fault = root.find('.//faultstring')
        if fault is not None:
            raise RuntimeError('BRENDA SOAP %s: %s' % (op, fault.text))
        items = []
        for e in root.iter():
            d = {c.tag.split('}')[-1]: ' '.join(''.join(c.itertext()).split()) for c in e}
            if 'ecNumber' in d and val in d:
                hi = d.get(val + 'Maximum', '')
                items.append('%s%s | %s | %s | %s' % (d[val], '-' + hi if hi not in ('', '-999') else '',
                                                      d.get(lig, ''), d.get('organism', ''), d.get('commentary', '')[:120]))
        out.append('## %s (%d)\n%s' % (val, len(items), '\n'.join(items[:ROWS])))
    return 'BRENDA SOAP, EC %s%s\n\n' % (ec, ' / ' + organism if organism else '') + '\n\n'.join(out)


def brenda(query):
    m = re.search(EC, query)
    if not m:
        r = get(BRENDA + 'search_result.php?' + qs(quicksearch=1, noOfResults=10, a=9, **{'W[2]': query, 'T[2]': 2}))
        rows = [[text_of(c)[:150] for c in tr.css('td')] for tr in r.css('tr')]
        rows = [x for x in rows if x and re.fullmatch(EC, x[0])]
        if not rows:
            return 'No BRENDA enzyme names match %r; pass an EC number (e.g. 1.1.1.1)' % query
        return 'BRENDA enzymes matching %r (rerun `brenda <EC>` for kinetics):\n' % query + \
            '\n'.join(' | '.join(x[:3]) for x in rows)
    ec, rest = m.group(), (query[:m.start()] + query[m.end():]).strip()
    if os.environ.get('BRENDA_EMAIL') and os.environ.get('BRENDA_PASSWORD'):
        return brenda_soap(ec, rest)
    r = get(BRENDA + 'enzyme.php?' + qs(ecno=ec), allow=(403, 429, 503))
    title = r.css('title::text').get() or ''
    if r.status >= 400 or 'Information on EC' not in title:
        raise RuntimeError('BRENDA public page for EC %s is blocked (HTTP %d); set BRENDA_EMAIL and '
                           'BRENDA_PASSWORD (free account at brenda-enzymes.org) to use the SOAP API' % (ec, r.status))
    out = [tidy(title), BRENDA + 'enzyme.php?ecno=' + ec,
           'columns: value | substrate/inhibitor | organism | commentary' + (' (filter: %r)' % rest if rest else '')]
    for a in r.css('a[name]'):
        name = a.attrib['name']
        if not name.startswith(TABLES):
            continue
        tab = (a.parent.attrib.get('id') or '').replace('_thp', '')
        rows = []
        for row in r.css('#%s > div[id*="sr"]' % tab):     # one per entry; grouped ones are class=hidden
            cells = [text_of(c) for c in row.css('div.cell')]
            if len(cells) >= 5 and (not rest or rest.lower() in ' '.join(cells).lower()):
                rows.append(' | '.join([cells[0], cells[1], cells[2], cells[4][:120]]))
        label = re.sub(r'<sup>(.*?)</sup>', r'^\1', name)
        out.append('\n## %s (%d rows%s)\n' % (label, len(rows), ', first %d' % ROWS if len(rows) > ROWS else '')
                   + '\n'.join(rows[:ROWS]))
    return '\n'.join(out)


BIOMODELS = 'https://www.ebi.ac.uk/biomodels/'
# sys-bio's mirror of the curated BioModels: a search cache (BiomodelsCache) and the SBML
# files (BiomodelsStore). Faster and steadier than the EBI API, which stays the fallback.
CACHE = 'https://raw.githubusercontent.com/sys-bio/BiomodelsCache/main/src/cached_biomodels.json'
STORE = 'https://raw.githubusercontent.com/sys-bio/BiomodelsStore/main/biomodels/'
LOCAL = os.path.join(tempfile.gettempdir(), 'mca-atlas-biomodels')


def biomodels_cache():
    """The 5 MB cache JSON, kept on disk a week (it is rebuilt monthly upstream)."""
    path = os.path.join(LOCAL, 'cached_biomodels.json')
    if not os.path.exists(path) or time.time() - os.path.getmtime(path) > 7 * 86400:
        os.makedirs(LOCAL, exist_ok=True)
        with open(path, 'wb') as f:
            f.write(get(CACHE).body)
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def cache_hits(db, query, n=15):
    """Every word must appear somewhere in the entry; name/title hits rank first."""
    words = query.lower().split()
    hits = []
    for mid, m in db.items():
        blob = json.dumps(m).lower()
        if all(w in blob for w in words):
            head = ((m.get('name') or '') + ' ' + (m.get('title') or '')).lower()
            hits.append((-sum(w in head for w in words), mid, m))
    hits.sort(key=lambda h: (h[0], h[1]))
    return len(hits), [(mid, m) for _, mid, m in hits[:n]]


def biomodels(query):
    mid = query.strip().upper()
    if not re.fullmatch(r'(BIOMD|MODEL)\d{10}', mid):
        try:
            total, hits = cache_hits(biomodels_cache(), query)
        except Exception:
            return ebi_biomodels(query)
        return ('%d curated BioModels match %r (BiomodelsCache, showing %d). '
                'Run `biomodels <id>` for one model as Antimony:\n' % (total, query, len(hits)) +
                '\n'.join('%s | %s | %s | %s %s' % (mid, m.get('name', ''), m.get('title', ''),
                                                    m.get('journal', ''), m.get('date', '')) for mid, m in hits))
    try:
        sbml = get(STORE + mid + '/' + mid + '_url.xml').body.decode('utf-8')
    except Exception:
        # not every model's file is <id>_url.xml: ask GitHub for the folder's first file
        ls = get('https://api.github.com/repos/sys-bio/BiomodelsStore/contents/biomodels/' + mid).json()
        xml = [f for f in ls if f['name'].endswith('.xml')] if isinstance(ls, list) else []
        if not xml:
            return ebi_biomodels(mid)
        sbml = get(xml[0]['download_url']).body.decode('utf-8')
    os.makedirs(LOCAL, exist_ok=True)
    path = os.path.join(LOCAL, mid + '.xml')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(sbml)
    m = biomodels_cache().get(mid, {}) if os.path.exists(os.path.join(LOCAL, 'cached_biomodels.json')) else {}
    head = '%s: %s\n%s\n%s %s %s\nSBML saved at %s (load it with te.loadSBMLModel)\n' % (
        mid, m.get('name', ''), m.get('title', ''), m.get('journal', ''), m.get('date', ''), m.get('url', ''), path)
    import antimony                      # in the venv with tellurium; only needed here
    if antimony.loadSBMLString(sbml) < 0:
        return head + '\n(SBML did not convert to Antimony: %s)' % antimony.getLastError()
    return head + '\n## Antimony\n\n' + antimony.getAntimonyString(None)


def ebi_biomodels(query):
    mid = query.strip().upper()
    if not re.fullmatch(r'(BIOMD|MODEL)\d{10}', mid):
        d = get(BIOMODELS + 'search?' + qs(query=query, numResults=10, format='json')).json()
        lines = ['%s | %s | %s | %s' % (m['id'], m['name'], m.get('format', ''), m.get('url', '')) for m in d.get('models', [])]
        return '%d BioModels matches for %r (showing %d):\n' % (d.get('matches', 0), query, len(lines)) + '\n'.join(lines)
    d = get(BIOMODELS + mid + '?format=json').json()
    pub = d.get('publication') or {}
    files = (d.get('files') or {}).get('main', []) + (d.get('files') or {}).get('additional', [])
    desc = page_text(Selector(d.get('description') or '<p></p>'))
    out = ['%s: %s' % (mid, d.get('name', '')), 'https://www.ebi.ac.uk/biomodels/' + mid,
           'format: %s | curation: %s' % ((d.get('format') or {}).get('name', ''), d.get('curationStatus', '')),
           'publication: %s (%s %s, %s %s)' % (pub.get('title', ''), pub.get('journal', ''), pub.get('year', ''),
                                               pub.get('type', ''), pub.get('accession', '')),
           '\nfiles (download URL):']
    out += ['  %s - %s (%s B)\n    %smodel/download/%s?filename=%s' % (f['name'], f.get('description', ''), f.get('fileSize', ''),
                                                                       BIOMODELS, mid, urllib.parse.quote(f['name'])) for f in files]
    return '\n'.join(out) + '\n\ndescription:\n' + cap(desc, 3000)


SABIO = 'https://sabiork.h-its.org/export-api/sabio/'


def sabio(query):
    # the legacy /sabioRestWebServices/ endpoints now 302 to a 404; this is their replacement
    q = query.strip()
    if re.fullmatch(EC, q):
        q = 'ECNumber:"%s"' % q
    d = get(SABIO + 'kinlaw-entry/json?' + qs(q=q, pageSize=30)).json()
    rows = ['EntryID\tOrganism\tEC\tEnzyme\tReaction\tParameter\tSpecies\tValue\tUnit\tpH\tT(C)\tPMID']
    for e in d.get('data', []):
        g, en, cond = e['general'], e['enzyme_description'], e['experimental_conditions']
        head = [e['id'], g['organism']['name'], en['ec_number'], en['enzyme_name'], e['reaction']['equation']]
        tail = [(cond.get('envvar_ph') or {}).get('start_value'), (cond.get('envvar_temperature') or {}).get('start_value'),
                (e.get('publication') or {}).get('pubmed_id')]
        for p in e['kineticlaw']['parameter']:
            if p['parameter_type']['name'] == 'concentration':
                continue
            species = (p['species'].get('species_key') or '').split(' | ')
            value = '%s%s' % (p['start_value'], '-%s' % p['end_value'] if p['end_value'] is not None else '')
            rows.append('\t'.join('' if v is None else str(v) for v in
                                  head + [p['name'], species[1] if len(species) > 1 else '', value, p['unit']['name']] + tail))
    total = d.get('meta', {}).get('total_count', 0)
    return 'SABIO-RK %s: %d kinetic-law entries (showing %d)\n' % (q, total, len(d.get('data', []))) + '\n'.join(rows)


JWS = 'https://jjj.mib.ac.uk/'


def jws(query):
    slug = query.strip()
    if re.fullmatch(r'[\w-]+', slug):
        r = get(JWS + 'rest/models/%s/?format=json' % slug, allow=(404,))
        if r.status == 200:
            d = r.json()
            out = ['JWS model %s | %smodels/%s/ | SBML: %smodels/%s/sbml/?download=1' % (slug, JWS, slug, JWS, slug)]
            for k, v in d.items():
                out.append('%s (%d): %s' % (k, len(v), ', '.join(map(str, v))) if isinstance(v, list) else '%s: %s' % (k, v))
            m = get(JWS + 'rest/models/%s/manuscript/?format=json' % slug, allow=(404,))
            if m.status == 200:
                m = m.json()
                out.insert(1, 'paper: %s (%s) PMID %s' % (m.get('title'), m.get('year'), m.get('pm_id')))
            return '\n'.join(out)
    # no such slug: match the query against the browse page's filter options, then list that filter
    r = get(JWS + 'models/')
    filt = None
    for name in ('process', 'organism', 'jwsmodel__model_type'):
        for o in r.css('select[name="%s"] option' % name):
            if o.attrib.get('value') and slug.lower() in (o.text or '').lower():
                filt = filt or (name, o.attrib['value'], o.text.strip('- '))
    if not filt:
        names = [m['slug'] for m in get(JWS + 'rest/models/?format=json').json() if slug.lower() in m['slug'].lower()]
        return ('JWS models with %r in the slug: %s' % (slug, ', '.join(names)) if names else
                'No JWS models match %r (try a process like glycolysis, an organism, or an author slug)' % query)
    rows, page = [], 1
    while page <= 5:                     # 32 models per page
        p = get(JWS + 'models/?' + qs(**{filt[0]: filt[1], 'page': page}))
        rows += [' | '.join(text_of(td) for td in tr.css('td')[:5]) for tr in p.css('tbody tr')]
        if 'page=%d"' % (page + 1) not in p.html_content:
            break
        page += 1
    return ('JWS models, %s = %s (%d; details: `jws <slug>`)\nmodel | organism | tissue | process | type\n'
            % (filt[0], filt[2], len(rows)) + '\n'.join(rows))


OPS = {'search': search, 'fetch': fetch, 'pubmed': pubmed, 'brenda': brenda,
       'biomodels': biomodels, 'sabio': sabio, 'jws': jws}


def run(argv):
    if len(argv) < 2 or argv[0] not in OPS or not ' '.join(argv[1:]).strip():
        raise ValueError('usage: web.py <%s> <arg>' % '|'.join(OPS))
    return cap(OPS[argv[0]](' '.join(argv[1:]).strip()))


if sys.argv[1:] == ['--selftest']:
    assert tidy('  a \t b \n\n\n c\xa0 ') == 'a b\nc'
    assert cap('x' * 10, 5) == 'xxxxx\n[truncated]' and cap(' ok ', 5) == 'ok'
    page = Selector('<html><head><style>p{}</style><script>bad()</script></head><body><nav>menu</nav>'
                    '<p>Flux <b>control</b> coefficient ( <a>MCA</a> ) .</p></body></html>')
    assert page_text(page) == 'Flux control coefficient (MCA).' and text_of(page.css('b')[0]) == 'control'
    for bad in ([], ['nope', 'x'], ['search'], ['fetch', '  ']):
        try:
            run(bad)
            raise AssertionError(bad)
        except ValueError as e:
            assert 'usage' in str(e)
    try:
        run(['fetch', 'ftp://x'])
        raise AssertionError('ftp accepted')
    except ValueError:
        pass
    db = {'BIOMD1': {'name': 'Teusink2000 glycolysis', 'title': 'yeast'}, 'BIOMD2': {'name': 'x', 'title': 'glycolysis in yeast'},
          'BIOMD3': {'name': 'repressilator'}}
    assert cache_hits(db, 'Glycolysis yeast') == (2, [('BIOMD1', db['BIOMD1']), ('BIOMD2', db['BIOMD2'])])
    assert re.fullmatch(EC, '1.1.1.1') and re.search(EC, 'EC 2.7.1.n2 yeast').group() == '2.7.1.n2'
    print('selftest ok')
    sys.exit(0)

if __name__ == '__main__':
    try:
        print(run(sys.argv[1:]))
    except BaseException as e:           # contract: one line, never a traceback
        if isinstance(e, SystemExit) and not e.code:
            raise
        print('ERROR: ' + (' '.join(str(e).split()) or type(e).__name__)[:400])
        sys.exit(1)
