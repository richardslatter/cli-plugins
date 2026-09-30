package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	teams "github.com/fossteams/teams-api"
	"github.com/fossteams/teams-api/pkg/csa"
	"golang.org/x/net/html"
)

type credentials struct {
	Account  string            `json:"account"`
	TenantID string            `json:"tenantId"`
	Tokens   map[string]string `json:"tokens"`
}
type claims struct {
	Tenant   string `json:"tid"`
	Audience string `json:"aud"`
	ObjectID string `json:"oid"`
	Expiry   int64  `json:"exp"`
}
type safeTransport struct{ inner http.RoundTripper }

func (s safeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.URL.Scheme != "https" || r.URL.User != nil || (r.URL.Host != "teams.microsoft.com" && r.URL.Host != "emea.ng.msg.teams.microsoft.com") {
		return nil, errors.New("unsupported Teams endpoint")
	}
	if r.Method != http.MethodGet && !(r.Method == http.MethodPost && r.URL.Host == "teams.microsoft.com" && r.URL.Path == "/api/authsvc/v1.0/authz") {
		return nil, errors.New("read-only transport rejected request")
	}
	return s.inner.RoundTrip(r)
}
func parseClaims(raw string) (claims, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return claims{}, errors.New("invalid token")
	}
	b, e := base64.RawURLEncoding.DecodeString(parts[1])
	if e != nil {
		return claims{}, e
	}
	var c claims
	e = json.Unmarshal(b, &c)
	return c, e
}
func loadCredentials(dir, tenant string) error {
	b, e := os.ReadFile(filepath.Join(dir, "credentials.json"))
	if e != nil {
		return errors.New("login_required")
	}
	var c credentials
	if json.Unmarshal(b, &c) != nil || c.TenantID != tenant {
		return errors.New("invalid_credentials")
	}
	subject := ""
	for kind, aud := range map[string]string{"skype": "https://api.spaces.skype.com", "chatsvcagg": "https://chatsvcagg.teams.microsoft.com"} {
		token := c.Tokens[kind]
		cl, e := parseClaims(token)
		if e != nil || cl.Tenant != tenant || cl.Audience != aud || cl.ObjectID == "" {
			return errors.New("invalid_credentials")
		}
		if cl.Expiry <= time.Now().Unix()+30 {
			return errors.New("login_required")
		}
		if subject != "" && cl.ObjectID != subject {
			return errors.New("mixed_credentials")
		}
		subject = cl.ObjectID
		if e = os.Setenv("MS_TEAMS_"+strings.ToUpper(kind)+"_TOKEN", token); e != nil {
			return errors.New("invalid_credentials")
		}
	}
	return nil
}

type Chat struct {
	ID           string `json:"id"`
	Title        string `json:"title"`
	Kind         string `json:"kind"`
	LastActivity string `json:"lastActivity,omitempty"`
}
type Message struct {
	ID     string `json:"id"`
	Sender string `json:"sender"`
	SentAt string `json:"sentAt"`
	Type   string `json:"type"`
	Text   string `json:"text"`
}

func textContent(raw string) string {
	z := html.NewTokenizer(strings.NewReader(raw))
	var b strings.Builder
	skip := 0
	for {
		switch z.Next() {
		case html.ErrorToken:
			return strings.TrimSpace(b.String())
		case html.StartTagToken:
			t := z.Token()
			if t.Data == "script" || t.Data == "style" {
				skip++
			}
			if t.Data == "br" && skip == 0 {
				b.WriteByte('\n')
			}
		case html.EndTagToken:
			t := z.Token()
			if (t.Data == "script" || t.Data == "style") && skip > 0 {
				skip--
			}
			if (t.Data == "p" || t.Data == "div" || t.Data == "li") && skip == 0 {
				b.WriteByte('\n')
			}
		case html.TextToken:
			if skip == 0 {
				b.Write(z.Text())
			}
		}
	}
}
func chatTitle(c csa.Chat, self string) string {
	if t := strings.TrimSpace(c.Title); t != "" {
		return t
	}
	if t := strings.TrimSpace(c.MeetingInformation.Subject); t != "" {
		return t
	}
	names := []string{}
	for _, m := range c.Members {
		if m.Mri != self && m.FriendlyName != "" {
			names = append(names, m.FriendlyName)
		}
	}
	if len(names) > 0 {
		return strings.Join(names, ", ")
	}
	return "Untitled chat"
}
func listChats(client *teams.TeamsClient, query string, limit, offset int) (any, error) {
	me, e := client.GetMe()
	if e != nil {
		return nil, errors.New("profile_read_failed")
	}
	data, e := client.GetConversations()
	if e != nil {
		return nil, errors.New("chat_list_failed")
	}
	rows := []Chat{}
	for _, c := range data.Chats {
		title := chatTitle(c, me.Mri)
		if query != "" && !strings.Contains(strings.ToLower(title), strings.ToLower(query)) {
			continue
		}
		last := time.Time(c.LastMessage.ComposeTime)
		date := ""
		if !last.IsZero() {
			date = last.Format(time.RFC3339)
		}
		rows = append(rows, Chat{c.Id, title, c.ChatType, date})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].LastActivity > rows[j].LastActivity })
	matched := len(rows)
	if offset > matched {
		offset = matched
	}
	end := offset + limit
	if end > matched {
		end = matched
	}
	return map[string]any{"totalChats": len(data.Chats), "matched": matched, "offset": offset, "hasMore": end < matched, "isPartial": data.Metadata.IsPartialData, "chats": rows[offset:end], "source": "Microsoft Teams"}, nil
}
func readMessages(client *teams.TeamsClient, id string, limit int) (any, error) {
	if id == "" || len(id) > 512 {
		return nil, errors.New("invalid_conversation_id")
	}
	endpoint := csa.MessagesHost + "v1/users/ME/conversations/" + url.QueryEscape(id) + "/messages"
	query := url.Values{"view": {"msnp24Equivalent|supportsMessageProperties"}, "pageSize": {fmt.Sprint(limit)}, "startTime": {"1"}}
	req, e := client.ChatSvc().AuthenticatedRequest(http.MethodGet, endpoint+"?"+query.Encode(), nil)
	if e != nil {
		return nil, errors.New("message_request_failed")
	}
	response, e := http.DefaultClient.Do(req)
	if e != nil {
		return nil, errors.New("message_request_failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("message_http_%d", response.StatusCode)
	}
	var data csa.MessagesResponse
	if json.NewDecoder(io.LimitReader(response.Body, 8<<20)).Decode(&data) != nil {
		return nil, errors.New("message_decode_failed")
	}
	sort.Sort(csa.SortMessageByTime(data.Messages))
	if len(data.Messages) > limit {
		data.Messages = data.Messages[len(data.Messages)-limit:]
	}
	rows := []Message{}
	for _, m := range data.Messages {
		t := textContent(m.Content)
		if len(t) > 20000 {
			t = t[:20000] + " [truncated]"
		}
		rows = append(rows, Message{m.Id, m.ImDisplayName, time.Time(m.ComposeTime).Format(time.RFC3339), m.MessageType, t})
	}
	return map[string]any{"conversationId": id, "count": len(rows), "messages": rows, "source": "Microsoft Teams", "contentIsUntrusted": true}, nil
}
func run() (any, error) {
	profile := flag.String("profile", "", "Private account directory")
	tenant := flag.String("tenant", "", "Expected tenant ID")
	action := flag.String("command", "", "chats or messages")
	query := flag.String("query", "", "Chat title filter")
	id := flag.String("conversation", "", "Conversation ID")
	limit := flag.Int("limit", 20, "Result limit (1-100)")
	offset := flag.Int("offset", 0, "Chat offset")
	flag.Parse()
	if *limit < 1 || *limit > 100 || *offset < 0 || *tenant == "" || *profile == "" {
		return nil, errors.New("invalid_arguments")
	}
	if *action != "chats" && *action != "messages" {
		return nil, errors.New("invalid_command")
	}
	if e := loadCredentials(*profile, *tenant); e != nil {
		return nil, e
	}
	http.DefaultClient = &http.Client{Timeout: 15 * time.Second, Transport: safeTransport{http.DefaultTransport}, CheckRedirect: func(req *http.Request, via []*http.Request) error { return http.ErrUseLastResponse }}
	client, e := teams.New()
	if e != nil {
		return nil, errors.New("teams_session_failed")
	}
	switch *action {
	case "chats":
		return listChats(client, *query, *limit, *offset)
	default:
		return readMessages(client, *id, *limit)
	}
}
func main() {
	result, err := run()
	if err != nil {
		json.NewEncoder(os.Stdout).Encode(map[string]string{"error": err.Error(), "message": "Teams read failed. Check account status; sign in again if the session expired."})
		os.Exit(1)
	}
	json.NewEncoder(os.Stdout).Encode(result)
}
