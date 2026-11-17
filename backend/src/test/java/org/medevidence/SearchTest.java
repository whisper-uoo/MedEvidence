package org.medevidence;

import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.*;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class SearchTest {
    private HttpServer upstream;
    private MockMvc api;
    private volatile int status = 200;
    private volatile long delay;
    private volatile String search = "<eSearchResult><Count>1</Count><IdList><Id>123</Id></IdList></eSearchResult>";
    private volatile String fetch = """
        <!DOCTYPE PubmedArticleSet SYSTEM "https://example.invalid/pubmed.dtd">
        <PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article>
        <ArticleTitle>A <i>study</i></ArticleTitle><Abstract><AbstractText Label="RESULTS">Example</AbstractText></Abstract>
        <AuthorList><Author><ForeName>Jane</ForeName><LastName>Doe</LastName></Author></AuthorList>
        <ELocationID EIdType="doi">10.1234/test</ELocationID><Journal><Title>Test journal</Title><JournalIssue><PubDate><MedlineDate>2020 Winter</MedlineDate></PubDate></JournalIssue></Journal>
        </Article></MedlineCitation></PubmedArticle></PubmedArticleSet>
        """;

    @BeforeEach
    void start() throws IOException {
        upstream = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        upstream.createContext("/", exchange -> {
            try {
                Thread.sleep(delay);
                byte[] body = (exchange.getRequestURI().getPath().contains("efetch") ? fetch : search)
                    .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().add("Retry-After", "5");
                exchange.sendResponseHeaders(status, body.length);
                exchange.getResponseBody().write(body);
            } catch (InterruptedException ex) {
                Thread.currentThread().interrupt();
            } finally {
                exchange.close();
            }
        });
        upstream.start();
        var base = java.net.URI.create("http://127.0.0.1:" + upstream.getAddress().getPort() + "/");
        api = MockMvcBuilders.standaloneSetup(new LiteratureController(new QueryAdapter(),
            new PubMedClient(base, java.time.Duration.ofSeconds(1), "", ""), org.mockito.Mockito.mock(ModelClient.class), null))
            .setControllerAdvice(new ApiErrors()).addPlaceholderValue("app.frontend-origin", "http://localhost:5173").build();
    }

    @AfterEach
    void stop() {
        if (upstream != null) upstream.stop(0);
    }

    private org.springframework.test.web.servlet.ResultActions send(String body) throws Exception {
        return api.perform(post("/api/literature/search").contentType("application/json").content(body));
    }

    @Test
    void adaptsChineseAndReturnsArticle() throws Exception {
        send("{\"query\":\"二甲双胍对2型糖尿病患者的效果？\"}").andExpect(status().isOk())
            .andExpect(jsonPath("$.data.pubmedQuery").value(org.hamcrest.Matchers.containsString("Metformin")))
            .andExpect(jsonPath("$.data.articles[0].title").value("A study"))
            .andExpect(jsonPath("$.data.articles[0].abstractText").value("RESULTS: Example"))
            .andExpect(jsonPath("$.data.articles[0].journal").value("Test journal"))
            .andExpect(jsonPath("$.data.articles[0].doi").value("10.1234/test"))
            .andExpect(jsonPath("$.data.articles[0].authors[0]").value("Jane Doe"))
            .andExpect(jsonPath("$.data.articles[0].publicationDate").value("2020 Winter"))
            .andExpect(jsonPath("$.data.articles[0].pubmedUrl").value("https://pubmed.ncbi.nlm.nih.gov/123/"));
    }

    @Test
    void validatesInputAndAcceptsEnglishOverride() throws Exception {
        send("{\"query\":\"  \"}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_QUERY"));
        send("{\"query\":\"未知罕见病\"}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("ENGLISH_QUERY_REQUIRED"));
        send("{\"query\":\"asthma\",\"limit\":51}").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_LIMIT"));
        send("{").andExpect(status().isBadRequest()).andExpect(jsonPath("$.code").value("INVALID_REQUEST"));
        search = "<eSearchResult><Count>0</Count><IdList/></eSearchResult>";
        send("{\"query\":\"未知罕见病\",\"englishQuery\":\"rare disease\"}").andExpect(status().isOk())
            .andExpect(jsonPath("$.code").value("NO_RESULTS"))
            .andExpect(jsonPath("$.data.pubmedQuery").value("rare disease"))
            .andExpect(jsonPath("$.data.articles").isEmpty());
    }

    @Test
    void preservesMissingArticleFields() throws Exception {
        fetch = "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>";
        send("{\"query\":\"asthma\"}").andExpect(status().isOk())
            .andExpect(jsonPath("$.data.articles[0].pmid").value("123"))
            .andExpect(jsonPath("$.data.articles[0].authors").isEmpty())
            .andExpect(jsonPath("$.data.articles[0].abstractText").value(org.hamcrest.Matchers.nullValue()));
    }

    @Test
    void exposesRateLimit() throws Exception {
        status = 429;
        send("{\"query\":\"asthma\"}").andExpect(status().isServiceUnavailable())
            .andExpect(header().string("Retry-After", "5")).andExpect(jsonPath("$.code").value("PUBMED_RATE_LIMITED"));
    }

    @Test
    void mapsTimeout() throws Exception {
        delay = 1500;
        send("{\"query\":\"asthma\"}").andExpect(status().isGatewayTimeout())
            .andExpect(jsonPath("$.code").value("PUBMED_TIMEOUT"));
    }

    @Test
    void mapsNetworkError() throws Exception {
        upstream.stop(0);
        send("{\"query\":\"asthma\"}").andExpect(status().isBadGateway())
            .andExpect(jsonPath("$.code").value("PUBMED_NETWORK_ERROR"));
    }

    @Test
    void rejectsMalformedUpstreamData() throws Exception {
        search = "<invalid/>";
        send("{\"query\":\"asthma\"}").andExpect(status().isBadGateway())
            .andExpect(jsonPath("$.code").value("PUBMED_INVALID_RESPONSE"));
    }
}
