package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Share struct {
	Ciphertext string    `json:"ciphertext"`
	FileName   string    `json:"fileName,omitempty"`
	MimeType   string    `json:"mimeType,omitempty"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type Store struct {
	mu     sync.Mutex
	shares map[string]Share
}

type createRequest struct {
	Ciphertext        string `json:"ciphertext"`
	ExpiresInSeconds  int    `json:"expiresInSeconds"`
	FileName          string `json:"fileName"`
	MimeType          string `json:"mimeType"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func randomID() (string, error) {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func (s *Store) create(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
		return
	}
	maxBytes := int64(10 << 20)
	if raw := os.Getenv("MAX_UPLOAD_BYTES"); raw != "" {
		if n, err := strconv.ParseInt(raw, 10, 64); err == nil && n > 0 {
			maxBytes = n
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBytes*2)
	defer r.Body.Close()

	var req createRequest
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON or request too large"})
		return
	}
	if req.Ciphertext == "" {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "ciphertext is required"})
		return
	}
	decoded, err := base64.StdEncoding.DecodeString(req.Ciphertext)
	if err != nil || int64(len(decoded)) > maxBytes {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid ciphertext or payload too large"})
		return
	}
	if req.ExpiresInSeconds != 300 && req.ExpiresInSeconds != 3600 && req.ExpiresInSeconds != 86400 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "expiresInSeconds must be 300, 3600, or 86400"})
		return
	}
	if len(req.FileName) > 255 || len(req.MimeType) > 120 {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "file metadata too long"})
		return
	}
	id, err := randomID()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, errorResponse{Error: "could not create share"})
		return
	}
	item := Share{
		Ciphertext: req.Ciphertext,
		FileName:   req.FileName,
		MimeType:   req.MimeType,
		ExpiresAt:  time.Now().Add(time.Duration(req.ExpiresInSeconds) * time.Second),
	}
	s.mu.Lock()
	s.shares[id] = item
	s.mu.Unlock()
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "expiresAt": item.ExpiresAt})
}

func (s *Store) get(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/shares/")
	if id == "" || strings.Contains(id, "/") {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "share not found or already opened"})
		return
	}

	// Delete while holding the lock: concurrent requests cannot both retrieve the secret.
	s.mu.Lock()
	item, ok := s.shares[id]
	if ok {
		delete(s.shares, id)
	}
	s.mu.Unlock()

	if !ok || time.Now().After(item.ExpiresAt) {
		writeJSON(w, http.StatusNotFound, errorResponse{Error: "share not found, expired, or already opened"})
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Store) health(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, errorResponse{Error: "method not allowed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func cors(next http.Handler) http.Handler {
	allowed := os.Getenv("ALLOWED_ORIGIN")
	if allowed == "" {
		allowed = "http://localhost:5173"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && origin == allowed {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			if origin != "" && origin != allowed {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func main() {
	store := &Store{shares: make(map[string]Share)}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", store.health)
	mux.HandleFunc("/api/shares", store.create)
	mux.HandleFunc("/api/shares/", store.get)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	server := &http.Server{
		Addr:              ":" + port,
		Handler:           securityHeaders(cors(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("Secure Share API listening on :%s", port)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
