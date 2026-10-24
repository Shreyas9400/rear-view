package app.smartrearview.rearcam.server;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Strict, small JSON parser (RFC 8259 subset) for the few inbound messages. No dependency, so it also runs in JVM unit tests
 * (Android's org.json is stubbed there). Objects become Map, arrays List, numbers Double, plus String, Boolean, null.
 * Bounded: input length and nesting depth are limited; anything unexpected throws {@link JsonException}.
 */
public final class MiniJson {
    public static final class JsonException extends Exception {
        public JsonException(String m) {
            super(m);
        }
    }

    private static final int MAX_DEPTH = 8;
    private final String s;
    private int i;

    private MiniJson(String s) {
        this.s = s;
    }

    public static Object parse(String text, int maxChars) throws JsonException {
        if (text == null || text.length() > maxChars) throw new JsonException("too long");
        MiniJson p = new MiniJson(text);
        p.ws();
        Object v = p.value(0);
        p.ws();
        if (p.i != text.length()) throw new JsonException("trailing characters");
        return v;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> parseObject(String text, int maxChars) throws JsonException {
        Object v = parse(text, maxChars);
        if (!(v instanceof Map)) throw new JsonException("not an object");
        return (Map<String, Object>) v;
    }

    private Object value(int depth) throws JsonException {
        if (depth > MAX_DEPTH) throw new JsonException("too deep");
        if (i >= s.length()) throw new JsonException("unexpected end");
        char c = s.charAt(i);
        switch (c) {
            case '{':
                return object(depth);
            case '[':
                return array(depth);
            case '"':
                return string();
            case 't':
                return literal("true", Boolean.TRUE);
            case 'f':
                return literal("false", Boolean.FALSE);
            case 'n':
                return literal("null", null);
            default:
                return number();
        }
    }

    private Object literal(String word, Object v) throws JsonException {
        if (!s.startsWith(word, i)) throw new JsonException("bad literal");
        i += word.length();
        return v;
    }

    private Map<String, Object> object(int depth) throws JsonException {
        Map<String, Object> m = new LinkedHashMap<>();
        i++;
        ws();
        if (peek() == '}') {
            i++;
            return m;
        }
        while (true) {
            ws();
            if (peek() != '"') throw new JsonException("expected key");
            String k = string();
            ws();
            if (peek() != ':') throw new JsonException("expected colon");
            i++;
            ws();
            m.put(k, value(depth + 1));
            ws();
            char c = peek();
            i++;
            if (c == '}') return m;
            if (c != ',') throw new JsonException("expected comma");
        }
    }

    private List<Object> array(int depth) throws JsonException {
        List<Object> l = new ArrayList<>();
        i++;
        ws();
        if (peek() == ']') {
            i++;
            return l;
        }
        while (true) {
            ws();
            l.add(value(depth + 1));
            ws();
            char c = peek();
            i++;
            if (c == ']') return l;
            if (c != ',') throw new JsonException("expected comma");
        }
    }

    private String string() throws JsonException {
        StringBuilder sb = new StringBuilder();
        i++;
        while (true) {
            if (i >= s.length()) throw new JsonException("unterminated string");
            char c = s.charAt(i++);
            if (c == '"') return sb.toString();
            if (c < 0x20) throw new JsonException("control character in string");
            if (c != '\\') {
                sb.append(c);
                continue;
            }
            if (i >= s.length()) throw new JsonException("bad escape");
            char e = s.charAt(i++);
            switch (e) {
                case '"': sb.append('"'); break;
                case '\\': sb.append('\\'); break;
                case '/': sb.append('/'); break;
                case 'b': sb.append('\b'); break;
                case 'f': sb.append('\f'); break;
                case 'n': sb.append('\n'); break;
                case 'r': sb.append('\r'); break;
                case 't': sb.append('\t'); break;
                case 'u':
                    if (i + 4 > s.length()) throw new JsonException("bad unicode escape");
                    try {
                        sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                    } catch (NumberFormatException ex) {
                        throw new JsonException("bad unicode escape");
                    }
                    i += 4;
                    break;
                default:
                    throw new JsonException("bad escape");
            }
        }
    }

    private Double number() throws JsonException {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        if (start == i) throw new JsonException("unexpected character");
        try {
            double d = Double.parseDouble(s.substring(start, i));
            if (Double.isNaN(d) || Double.isInfinite(d)) throw new JsonException("bad number");
            return d;
        } catch (NumberFormatException e) {
            throw new JsonException("bad number");
        }
    }

    private char peek() throws JsonException {
        if (i >= s.length()) throw new JsonException("unexpected end");
        return s.charAt(i);
    }

    private void ws() {
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++;
            else break;
        }
    }
}
