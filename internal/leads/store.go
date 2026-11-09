package leads

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const PageSize = 50
const SeedCount = 150

var stages = []string{"Lead Captured", "Lead Qualified", "Contact Established", "Needs Assessment", "Proposal Sent", "Negotiation", "Deal Approved", "Contract Created"}

func Stages() []string { return append([]string{}, stages...) }
func validStage(stage string) bool {
	for _, s := range stages {
		if s == stage {
			return true
		}
	}
	return false
}

type Lead struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Company   string `json:"company"`
	Email     string `json:"email"`
	Owner     string `json:"owner"`
	Value     int    `json:"value"`
	Stage     string `json:"stage"`
	UpdatedAt string `json:"updatedAt"`
	Version   int    `json:"version"`
}
type Summary struct {
	Total         int            `json:"total"`
	PipelineValue int            `json:"pipelineValue"`
	StageCounts   map[string]int `json:"stageCounts"`
}
type Page struct {
	Leads      []Lead   `json:"leads"`
	Page       int      `json:"page"`
	PageSize   int      `json:"pageSize"`
	Total      int      `json:"total"`
	TotalPages int      `json:"totalPages"`
	Query      string   `json:"query"`
	Stage      string   `json:"stage"`
	Stages     []string `json:"stages"`
	Currency   string   `json:"currency"`
	Summary    Summary  `json:"summary"`
}
type Store struct {
	mu    sync.RWMutex
	path  string
	leads []Lead
}

func OpenStore(dir string) (*Store, error) {
	if dir == "" {
		dir = ".data"
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{path: filepath.Join(dir, "leads.json")}
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.leads = seedLeads()
		if err = s.save(s.leads); err != nil {
			return nil, err
		}
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, &s.leads); err != nil {
		return nil, fmt.Errorf("read leads: %w", err)
	}
	if len(s.leads) != SeedCount {
		return nil, fmt.Errorf("expected %d stored mock leads", SeedCount)
	}
	ids := map[string]bool{}
	for _, l := range s.leads {
		if l.ID == "" || ids[l.ID] || !validStage(l.Stage) || l.Version < 1 {
			return nil, fmt.Errorf("invalid stored lead %q", l.ID)
		}
		ids[l.ID] = true
	}
	return s, nil
}
func seedLeads() []Lead {
	first := []string{"Olivia", "Noah", "Emma", "Liam", "Amelia", "Elijah", "Sophia", "James", "Charlotte", "Lucas", "Isabella", "Mason", "Mia", "Ethan", "Harper", "Arjun", "Ava", "Leo", "Sofia", "Oliver", "Grace", "Theo", "Chloe", "Kai", "Ella", "Nora", "Jack", "Lily", "Henry", "Zoe"}
	last := []string{"Chen", "Patel", "Morgan", "Rivera", "Kim"}
	companies := []string{"Northstar Labs", "Atlas Studio", "Bloom Commerce", "Cedar Systems", "Orbit Digital", "Pioneer Foods", "Harbor Logistics", "Summit Health", "Lumen Energy", "Verve Design", "Evergreen Retail", "Nova Software", "Bluebird Media", "Meridian Works", "Aspen Finance", "Coral Travel", "Foundry Robotics", "Maple Education", "Opal Analytics", "Beacon Group", "Vertex Cloud", "Meadow Organics", "Pacific Mobility", "Quartz Security", "Redwood Partners", "Solstice Hotels", "Tidal Networks", "Unity Ventures", "Willow Living", "Zenith Supply"}
	owners := []string{"Alex Parker", "Jamie Lee", "Sam Taylor", "Jordan Davis", "Riley Wilson"}
	leads := make([]Lead, 0, SeedCount)
	for i := 0; i < SeedCount; i++ {
		leads = append(leads, Lead{ID: fmt.Sprintf("LEAD-%03d", i+1), Name: first[i%len(first)] + " " + last[i/len(first)], Company: companies[(i*7+i/30)%len(companies)], Email: fmt.Sprintf("%s.%s.%03d@example.com", strings.ToLower(first[i%len(first)]), strings.ToLower(last[i/len(first)]), i+1), Owner: owners[i%len(owners)], Value: 2500 + ((i * 1379) % 47500), Stage: stages[i%len(stages)], UpdatedAt: time.Date(2026, 11, 1+(i%8), 9+i%8, 0, 0, 0, time.UTC).Format(time.RFC3339), Version: 1})
	}
	return leads
}
func (s *Store) save(leads []Lead) error {
	b, err := json.MarshalIndent(leads, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(s.path), ".leads-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), s.path)
}
func (s *Store) List(page int, query, stage string) (Page, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if page < 1 {
		return Page{}, fmt.Errorf("page must be at least 1")
	}
	if stage != "" && !validStage(stage) {
		return Page{}, fmt.Errorf("unknown stage")
	}
	summary := Summary{Total: len(s.leads), StageCounts: map[string]int{}}
	for _, s := range stages {
		summary.StageCounts[s] = 0
	}
	matches := []Lead{}
	query = strings.TrimSpace(query)
	q := strings.ToLower(query)
	for _, l := range s.leads {
		summary.PipelineValue += l.Value
		summary.StageCounts[l.Stage]++
		if (stage == "" || l.Stage == stage) && strings.Contains(strings.ToLower(l.ID+" "+l.Name+" "+l.Company+" "+l.Email+" "+l.Owner), q) {
			matches = append(matches, l)
		}
	}
	pages := (len(matches) + PageSize - 1) / PageSize
	if pages == 0 {
		pages = 1
	}
	if page > pages {
		return Page{}, fmt.Errorf("page must be between 1 and %d", pages)
	}
	start := (page - 1) * PageSize
	end := min(start+PageSize, len(matches))
	items := append([]Lead{}, matches[start:end]...)
	return Page{Leads: items, Page: page, PageSize: PageSize, Total: len(matches), TotalPages: pages, Query: query, Stage: stage, Stages: Stages(), Currency: "USD", Summary: summary}, nil
}
func (s *Store) UpdateStage(id, stage string, version int) (Lead, error) {
	if !validStage(stage) {
		return Lead{}, fmt.Errorf("unknown stage")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, l := range s.leads {
		if l.ID == id {
			if l.Version != version {
				return Lead{}, fmt.Errorf("this lead changed elsewhere; refresh the list and try again")
			}
			if l.Stage == stage {
				return l, nil
			}
			l.Stage = stage
			l.Version++
			l.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
			next := append([]Lead{}, s.leads...)
			next[i] = l
			if err := s.save(next); err != nil {
				return Lead{}, err
			}
			s.leads = next
			return l, nil
		}
	}
	return Lead{}, fmt.Errorf("unknown lead %q", id)
}
